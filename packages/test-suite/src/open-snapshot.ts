import crypto from "node:crypto";
import { INCOMPLETE_GENERATION_STATUSES, Prisma, type PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { toSlug } from "@autonoma/utils";
import {
    PlanNotOnTestCaseError,
    SlugAllocationError,
    SnapshotNotFoundError,
    SnapshotNotOpenError,
    TestNotAssignedError,
    TestPlanMissingError,
} from "./errors";
import { type Suite, readSuite } from "./queries/read-suite";

/** How many fresh random suffixes a slug collision is retried with before giving up. */
const MAX_SLUG_ATTEMPTS = 3;

export interface AddTestInput {
    name: string;
    /** Falsifiable behavioral claim, persisted as the test case's immutable `description`; the `scenario_unsupported` reviewer anchors on it. */
    description: string;
    plan: string;
    folderId: string;
    scenarioId?: string;
    scenarioName?: string;
}

export interface AdoptTestInput {
    /** An existing test case of this application that the snapshot does not assign yet. */
    testCaseId: string;
    plan: string;
    scenarioId?: string;
}

export interface RevisePlanInput {
    testCaseId: string;
    plan: string;
    scenarioId?: string;
}

export interface RestorePlanInput {
    testCaseId: string;
    /** The plan record the assignment held before the edit being undone. Must belong to the test case. */
    planId: string;
}

/** Identity of the snapshot an `OpenSnapshot` operates on, resolved by the store at construction. */
export interface OpenSnapshotIdentity {
    snapshotId: string;
    branchId: string;
    applicationId: string;
    organizationId: string;
    headSha?: string;
    baseSha?: string;
}

/**
 * The client an `OpenSnapshot` writes through: the root client, or the transaction a
 * `withTransaction` body runs in - in which case every call composes into that transaction
 * instead of opening its own.
 */
type ClientBinding = { kind: "root"; db: PrismaClient } | { kind: "transaction"; tx: Prisma.TransactionClient };

/**
 * The handle on one open (`processing`) snapshot - the only way the suite of that snapshot is
 * edited, the only way a run begins, and the thing whose terminal IS the settlement mutex.
 *
 * Every mutation asserts the snapshot is still open inside its own transaction (taking a share
 * lock on the snapshot row, which a concurrent terminal's status flip must wait for), so a
 * terminal snapshot is immutable by construction - a handle held across a settlement cannot
 * write through it.
 *
 * No edit ever creates a run: `startRun` is the single point a `TestGeneration` comes into
 * existence, and nothing here deletes one - a run, once started, is a permanent record the
 * analysis classifications hang off.
 *
 * Instances are obtained via `TestSuiteStore.openSnapshot` / `reopen`, never constructed directly.
 */
export class OpenSnapshot {
    private readonly logger: Logger;

    public readonly snapshotId: string;
    public readonly branchId: string;
    public readonly applicationId: string;
    public readonly organizationId: string;
    /** Absent on snapshots opened without git coordinates (the manual editor's). */
    public readonly headSha?: string;
    public readonly baseSha?: string;

    private readonly log: {
        info: (message: string, extra?: Record<string, unknown>) => void;
        warn: (message: string, extra?: Record<string, unknown>) => void;
    };

    constructor(
        private readonly binding: ClientBinding,
        identity: OpenSnapshotIdentity,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
        const snapshot = { snapshotId: identity.snapshotId };
        this.log = {
            info: (message, extra) => this.logger.info(message, { snapshot, extra }),
            warn: (message, extra) => this.logger.warn(message, { snapshot, extra }),
        };
        this.snapshotId = identity.snapshotId;
        this.branchId = identity.branchId;
        this.applicationId = identity.applicationId;
        this.organizationId = identity.organizationId;
        this.headSha = identity.headSha;
        this.baseSha = identity.baseSha;
    }

    /** Create a new test case with its first plan and assign it to this snapshot, atomically. */
    public async addTest(input: AddTestInput): Promise<{ testCaseId: string; planId: string; slug: string }> {
        this.log.info("Adding new test case", { name: input.name });

        const slugBase = toSlug(input.name);
        const preferredSlug = (await this.slugTaken(slugBase)) ? this.suffixedSlug(slugBase) : slugBase;

        // A slug collision aborts the enclosing Postgres transaction, so each attempt must be its
        // own transaction - inside a caller's `withTransaction` there is nothing to retry into and
        // the collision propagates.
        for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
            const slug = attempt === 0 ? preferredSlug : this.suffixedSlug(slugBase);
            try {
                return await this.inTransaction((tx) => this.createTest(tx, input, slug));
            } catch (error) {
                const retryable = isUniqueViolation(error) && this.binding.kind === "root";
                if (!retryable) throw error;
                this.log.warn("Test case slug collided; retrying with a fresh suffix", { slug, attempt });
            }
        }
        throw new SlugAllocationError(input.name, MAX_SLUG_ATTEMPTS);
    }

    /**
     * Assign an existing test case to this snapshot with a freshly minted plan - the merge-import
     * case, where a test authored on a merged feature branch joins this branch's suite for the
     * first time. Deliberately not `addTest`: the `TestCase` already exists application-wide, and
     * minting a second one would fork the test's identity (a new slug, none of its history).
     */
    public async adoptTest(input: AdoptTestInput): Promise<{ planId: string }> {
        this.log.info("Adopting test case into snapshot", { testCaseId: input.testCaseId });

        return this.inTransaction(async (tx) => {
            await this.assertOpen(tx);
            const planId = await this.mintPlan(tx, input);
            await tx.testCaseAssignment.create({
                data: { snapshotId: this.snapshotId, testCaseId: input.testCaseId, planId },
            });
            return { planId };
        });
    }

    /** Mint a new plan for a test this snapshot assigns and repoint the assignment at it. */
    public async revisePlan(input: RevisePlanInput): Promise<{ planId: string }> {
        this.log.info("Revising plan for test case", { testCaseId: input.testCaseId, scenarioId: input.scenarioId });

        return this.inTransaction(async (tx) => {
            await this.assertOpen(tx);
            await this.requireAssignment(tx, input.testCaseId);
            const planId = await this.mintPlan(tx, input);
            await tx.testCaseAssignment.update({
                where: { snapshotId_testCaseId: { snapshotId: this.snapshotId, testCaseId: input.testCaseId } },
                data: { planId },
            });
            return { planId };
        });
    }

    /**
     * Repoint a test's assignment at a plan record it already had, without minting a new one.
     * Restoring the id the assignment held before an edit makes the snapshot genuinely unchanged
     * for that test - the `planId`-keyed change computations do not report it as modified, which
     * re-authoring the same text would.
     */
    public async restorePlan({ testCaseId, planId }: RestorePlanInput): Promise<void> {
        this.log.info("Restoring a previous plan for test case", { testCaseId, planId });

        await this.inTransaction(async (tx) => {
            await this.assertOpen(tx);
            await this.requireAssignment(tx, testCaseId);
            const plan = await tx.testPlan.findUnique({ where: { id: planId }, select: { testCaseId: true } });
            if (plan == null || plan.testCaseId !== testCaseId) throw new PlanNotOnTestCaseError(planId, testCaseId);
            await tx.testCaseAssignment.update({
                where: { snapshotId_testCaseId: { snapshotId: this.snapshotId, testCaseId } },
                data: { planId },
            });
        });
    }

    /**
     * Remove a test from this snapshot by deleting its assignment. The `TestCase` survives - an
     * unassigned test case is invisible to every catalog read, and destroying it would cascade
     * away the record of why it was removed.
     *
     * Idempotent: no assignment is a logged no-op, so a contained removal can be retried safely.
     */
    public async dropTest(testCaseId: string): Promise<void> {
        this.log.info("Dropping test case from snapshot", { testCaseId });

        await this.inTransaction(async (tx) => {
            await this.assertOpen(tx);
            const { count } = await tx.testCaseAssignment.deleteMany({
                where: { snapshotId: this.snapshotId, testCaseId },
            });
            if (count === 0) {
                this.log.warn("No assignment to drop; skipping", { testCaseId });
            }
        });
    }

    /**
     * Revert a test to what the source snapshot held: the source's assignment if it had one, or no
     * assignment at all for a test added in this snapshot (whose `TestCase` survives unassigned,
     * like any other dropped test). Runs the test already started are left untouched.
     */
    public async discardTest(testCaseId: string): Promise<void> {
        this.log.info("Discarding test case changes", { testCaseId });

        await this.inTransaction(async (tx) => {
            await this.assertOpen(tx);
            const snapshot = await tx.branchSnapshot.findUniqueOrThrow({
                where: { id: this.snapshotId },
                select: { prevSnapshotId: true },
            });

            await tx.testCaseAssignment.deleteMany({ where: { snapshotId: this.snapshotId, testCaseId } });

            const previousAssignment =
                snapshot.prevSnapshotId == null
                    ? undefined
                    : await tx.testCaseAssignment.findUnique({
                          where: {
                              snapshotId_testCaseId: { snapshotId: snapshot.prevSnapshotId, testCaseId },
                          },
                          select: { planId: true },
                      });
            if (previousAssignment == null) {
                this.log.info("No previous assignment; the test was added in this snapshot", { testCaseId });
                return;
            }

            await tx.testCaseAssignment.create({
                data: {
                    snapshotId: this.snapshotId,
                    testCaseId,
                    planId: previousAssignment.planId ?? undefined,
                },
            });
        });
    }

    /**
     * Resolve the test's pinned plan and start one execution. The only way a run begins - no suite
     * edit queues one. Returns the scenario the pinned plan carries so the caller can provision it
     * before the run executes.
     */
    public async startRun(testCaseId: string): Promise<{ runId: string; scenarioId?: string }> {
        this.log.info("Starting a run", { testCaseId });

        return this.inTransaction(async (tx) => {
            await this.assertOpen(tx);
            const assignment = await this.requireAssignment(tx, testCaseId);
            if (assignment.planId == null) throw new TestPlanMissingError(this.snapshotId, testCaseId);

            const run = await tx.testGeneration.create({
                data: {
                    testPlanId: assignment.planId,
                    snapshotId: this.snapshotId,
                    organizationId: this.organizationId,
                },
                select: { id: true },
            });

            const scenarioId = assignment.plan?.scenarioId ?? undefined;
            this.log.info("Run started", { testCaseId, runId: run.id, planId: assignment.planId, scenarioId });
            return { runId: run.id, scenarioId };
        });
    }

    /** The suite as this snapshot currently assigns it. */
    public async read(): Promise<Suite> {
        return readSuite(this.client, this.snapshotId);
    }

    /**
     * Run several suite operations atomically: the body receives a handle bound to one transaction, and every
     * call through it commits or rolls back together. Within an already transactional handle, the body simply
     * joins the ongoing transaction.
     *
     * The raw transaction client rides along so a caller can commit its OWN rows with the suite edit, rather
     * than after it - which would leave a window where the suite moved and the caller's row did not.
     */
    public async withTransaction<T>(
        fn: (snapshot: OpenSnapshot, tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
        if (this.binding.kind === "transaction") return fn(this, this.binding.tx);
        return this.binding.db.$transaction((tx) => fn(new OpenSnapshot({ kind: "transaction", tx }, this), tx));
    }

    /**
     * Terminal: promote this snapshot to the branch's active suite, superseding the previous
     * active snapshot. Unconditional on what did or did not run - a coverage gap is the
     * Reporter's fact to report, not a promotion veto.
     *
     * Exactly one terminal wins, and each IS the compare-and-swap: `false` means another actor
     * settled this snapshot first, and this caller must skip its dependent side effects.
     */
    public async promote(): Promise<boolean> {
        this.log.info("Promoting snapshot");

        return this.inTransaction(async (tx) => {
            const claimed = await this.claimTerminal(tx, "active");
            if (!claimed) return false;

            const branch = await tx.branch.findUniqueOrThrow({
                where: { id: this.branchId },
                select: { activeSnapshotId: true },
            });
            if (branch.activeSnapshotId != null) {
                this.log.info("Marking previous active snapshot as superseded", {
                    previousSnapshotId: branch.activeSnapshotId,
                });
                await tx.branchSnapshot.update({
                    where: { id: branch.activeSnapshotId },
                    data: { status: "superseded" },
                });
            }
            await tx.branch.update({
                where: { id: this.branchId },
                data: { activeSnapshotId: this.snapshotId, pendingSnapshotId: null },
            });

            this.log.info("Snapshot promoted");
            return true;
        });
    }

    /** Terminal: mark this snapshot failed. See {@link promote} for the compare-and-swap contract. */
    public async fail(reason: string): Promise<boolean> {
        return this.close("failed", reason);
    }

    /** Terminal: mark this snapshot cancelled. See {@link promote} for the compare-and-swap contract. */
    public async cancel(reason: string): Promise<boolean> {
        return this.close("cancelled", reason);
    }

    /**
     * A non-promoting terminal keeps every row for observability: assignments and runs survive, the
     * branch's pending pointer is cleared, and the runs the outcome cut short are marked failed
     * with the reason - never deleted, since a run is the anchor its classification hangs off.
     */
    private async close(status: "failed" | "cancelled", reason: string): Promise<boolean> {
        this.log.info("Closing snapshot", { status, reason });

        return this.inTransaction(async (tx) => {
            const claimed = await this.claimTerminal(tx, status);
            if (!claimed) return false;

            await tx.branch.update({ where: { id: this.branchId }, data: { pendingSnapshotId: null } });
            const interrupted = await tx.testGeneration.updateMany({
                where: { snapshotId: this.snapshotId, status: { in: INCOMPLETE_GENERATION_STATUSES } },
                data: { status: "failed", failure: { kind: "engine_error", message: reason } },
            });

            this.log.info("Snapshot closed", { status, interruptedRuns: interrupted.count });
            return true;
        });
    }

    /**
     * The compare-and-swap every terminal goes through: flip the status off `processing` if and
     * only if this snapshot is still the branch's pending snapshot. The conditional update takes
     * the row lock, so concurrent terminals serialize on it and exactly one observes the swap.
     */
    private async claimTerminal(
        tx: Prisma.TransactionClient,
        status: "active" | "failed" | "cancelled",
    ): Promise<boolean> {
        const { count } = await tx.branchSnapshot.updateMany({
            where: {
                id: this.snapshotId,
                status: "processing",
                pendingOnBranch: { is: { id: this.branchId } },
            },
            data: { status },
        });
        if (count === 0) {
            this.log.warn("Lost the settlement race; another actor already settled this snapshot", {
                attemptedStatus: status,
            });
        }
        return count > 0;
    }

    private get client(): PrismaClient | Prisma.TransactionClient {
        return this.binding.kind === "root" ? this.binding.db : this.binding.tx;
    }

    private async inTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
        if (this.binding.kind === "transaction") return fn(this.binding.tx);
        return this.binding.db.$transaction(fn);
    }

    /**
     * Assert the snapshot is still open, taking a share lock on its row so a concurrent terminal's
     * status flip must wait for this mutation to commit - which is what makes terminal snapshots
     * immutable even against a handle that loaded before the terminal landed.
     */
    private async assertOpen(tx: Prisma.TransactionClient): Promise<void> {
        const rows = await tx.$queryRaw<
            { status: string }[]
        >`SELECT status FROM branch_snapshot WHERE id = ${this.snapshotId} FOR SHARE`;
        const row = rows[0];
        if (row == null) throw new SnapshotNotFoundError(this.snapshotId);
        if (row.status !== "processing") throw new SnapshotNotOpenError(this.snapshotId, row.status);
    }

    private async requireAssignment(tx: Prisma.TransactionClient, testCaseId: string) {
        const assignment = await tx.testCaseAssignment.findUnique({
            where: { snapshotId_testCaseId: { snapshotId: this.snapshotId, testCaseId } },
            select: { planId: true, plan: { select: { scenarioId: true } } },
        });
        if (assignment == null) throw new TestNotAssignedError(this.snapshotId, testCaseId);
        return assignment;
    }

    private async mintPlan(
        tx: Prisma.TransactionClient,
        {
            testCaseId,
            plan,
            scenarioId,
            scenarioName,
        }: { testCaseId: string; plan: string; scenarioId?: string; scenarioName?: string },
    ): Promise<string> {
        const created = await tx.testPlan.create({
            data: {
                testCaseId,
                prompt: plan,
                scenarioId,
                scenarioName,
                organizationId: this.organizationId,
            },
            select: { id: true },
        });
        return created.id;
    }

    private async createTest(
        tx: Prisma.TransactionClient,
        input: AddTestInput,
        slug: string,
    ): Promise<{ testCaseId: string; planId: string; slug: string }> {
        await this.assertOpen(tx);
        const testCase = await tx.testCase.create({
            data: {
                name: input.name,
                slug,
                description: input.description,
                folderId: input.folderId,
                organizationId: this.organizationId,
                applicationId: this.applicationId,
            },
            select: { id: true },
        });
        const planId = await this.mintPlan(tx, {
            testCaseId: testCase.id,
            plan: input.plan,
            scenarioId: input.scenarioId,
            scenarioName: input.scenarioName,
        });

        await tx.testCaseAssignment.create({
            data: { snapshotId: this.snapshotId, testCaseId: testCase.id, planId },
        });

        this.log.info("Test case created and assigned", { testCaseId: testCase.id, planId, slug });
        return { testCaseId: testCase.id, planId, slug };
    }

    private async slugTaken(slug: string): Promise<boolean> {
        const existing = await this.client.testCase.findFirst({
            where: { applicationId: this.applicationId, slug },
            select: { id: true },
        });
        return existing != null;
    }

    private suffixedSlug(slugBase: string): string {
        return `${slugBase}-${crypto.randomBytes(4).toString("hex")}`;
    }
}

function isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
