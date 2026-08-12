import { type Prisma, type PrismaClient, type SnapshotStatus, TriggerSource } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    BranchAlreadyOpenError,
    BranchNotFoundError,
    ForeignSourceSnapshotError,
    NoSnapshotBaseError,
    SourceMovedError,
    SnapshotNotFoundError,
    SnapshotNotOpenError,
} from "./errors";
import { OpenSnapshot, type OpenSnapshotIdentity } from "./open-snapshot";
import { copyForwardSuite } from "./queries/copy-forward";
import { type SuiteAssignment, readAssignments } from "./queries/read-assignments";
import { type SuiteRun, readLatestRunPerTest } from "./queries/read-runs";
import { type Suite, readSuite } from "./queries/read-suite";
import {
    type ResolveSourceInput,
    type ResolvedSnapshotSource,
    type SnapshotSource,
    deriveBaseSha,
    resolveSnapshotSource,
} from "./queries/resolve-source";
import { type SuiteChange, computeSuiteChanges } from "./queries/suite-changes";
import { type SnapshotComparison, type SuiteChangeSummary, summarizeSuiteChanges } from "./queries/summarize-changes";

/**
 * The trigger an edit session's snapshot carries. It is what tells the manual editor's snapshot apart from an
 * analysis run's in the branch's single pending slot, so the editor can refuse a snapshot it does not own.
 */
export const EDIT_SNAPSHOT_TRIGGER = TriggerSource.MANUAL;

export interface OpenEditSnapshotInput {
    branchId: string;
    /** When provided, verifies the branch belongs to this organization. */
    organizationId?: string;
}

/** A branch's newest run. Distinct from {@link SuiteRun}, which is one test's newest run within a snapshot. */
export interface LatestRun {
    snapshotId: string;
    status: SnapshotStatus;
    /** Absent on snapshots opened without git coordinates. */
    headSha?: string;
    createdAt: Date;
}

export interface OpenSnapshotInput {
    branchId: string;
    /** When provided, verifies the branch belongs to this organization. */
    organizationId?: string;
    /** The head commit this snapshot's suite is for. */
    headSha: string;
    /**
     * The snapshot this run reads and forks from; `baseSha` is derived from its head. Normally
     * produced by {@link TestSuiteStore.resolveSource} rather than assembled by hand.
     */
    source: SnapshotSource;
    trigger: TriggerSource;
    /** Runs inside the transaction that creates the snapshot, so a caller's own rows for the run commit with it. */
    onOpened?: (tx: Prisma.TransactionClient, identity: OpenSnapshotIdentity) => Promise<void>;
}

/**
 * The suite module's entry point. Its aggregate is a branch's suite lineage: the line of immutable
 * snapshots, the single open snapshot being written, the branch's three pointers, and the runs.
 * It writes `test_case`, `test_plan`, `test_case_assignment`, `branch_snapshot`, `branch` and
 * `test_generation`, and never touches an `analysis_*` table.
 */
export class TestSuiteStore {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Open a new snapshot on the branch: create it from the given source, copy the source's suite
     * forward, and set it as the branch's pending snapshot.
     *
     * A branch holds at most one open snapshot. When one is already open this throws
     * {@link BranchAlreadyOpenError} carrying its id - a superseding caller settles that snapshot
     * (the loser must detect that it lost) and retries.
     */
    public async openSnapshot(input: OpenSnapshotInput): Promise<OpenSnapshot> {
        const { branchId, headSha, source, trigger } = input;
        this.logger.info("Opening a new snapshot", { branch: { branchId }, extra: { headSha, trigger } });

        const identity = await this.db.$transaction(async (tx) => {
            const branch = await this.lockBranchForOpen(tx, branchId, input.organizationId);

            const resolved = await this.resolveSourceRow(tx, branchId, branch.applicationId, source);
            this.assertSourceStillCurrent(branchId, branch.activeSnapshotId ?? undefined, resolved);

            const created = await tx.branchSnapshot.create({
                data: {
                    branchId,
                    source: trigger,
                    headSha,
                    baseSha: resolved.baseSha,
                    prevSnapshotId: resolved.sourceSnapshotId,
                },
                select: { id: true },
            });
            if (resolved.sourceSnapshotId != null) {
                await copyForwardSuite({
                    tx,
                    sourceSnapshotId: resolved.sourceSnapshotId,
                    targetSnapshotId: created.id,
                });
            }

            // Pin the fork point the first time this branch forks from another branch's snapshot:
            // that source is the merge base the PR diff view compares against. Set once, never
            // re-pinned.
            const shouldPinBase =
                branch.baseSnapshotId == null &&
                resolved.sourceBranchId != null &&
                resolved.sourceBranchId !== branchId;
            if (shouldPinBase) {
                this.logger.info("Pinning base snapshot on first snapshot", {
                    branch: { branchId },
                    extra: { baseSnapshotId: resolved.sourceSnapshotId },
                });
            }
            await tx.branch.update({
                where: { id: branchId },
                data: {
                    pendingSnapshotId: created.id,
                    baseSnapshotId: shouldPinBase ? resolved.sourceSnapshotId : undefined,
                },
            });

            const identity: OpenSnapshotIdentity = {
                snapshotId: created.id,
                branchId,
                applicationId: branch.applicationId,
                organizationId: branch.organizationId,
                trigger,
                headSha,
                baseSha: resolved.baseSha,
            };
            await input.onOpened?.(tx, identity);
            return identity;
        });

        this.logger.info("Snapshot opened", {
            branch: { branchId },
            snapshot: { snapshotId: identity.snapshotId, headSha, baseSha: identity.baseSha },
        });
        return new OpenSnapshot({ kind: "root", db: this.db }, identity);
    }

    /**
     * Open a snapshot for a manual edit session, forking from the branch's active snapshot.
     *
     * An edit changes the suite, not the commit, so the snapshot inherits the active one's `headSha` as both its
     * head and its base rather than advancing either: the next analysis then still diffs from the sha the branch
     * was last analyzed at, instead of treating the edit as a new base. That is also why there is no `source`
     * parameter - an edit has nowhere else it could fork from - and no `headSha`: a branch whose suite arrived
     * through onboarding has no sha to inherit, and an edit is legal there.
     *
     * Like {@link openSnapshot}, throws {@link BranchAlreadyOpenError} when the branch's single pending slot is
     * taken - by another edit session, or by an analysis run the editor must not touch.
     */
    public async openEditSnapshot({ branchId, organizationId }: OpenEditSnapshotInput): Promise<OpenSnapshot> {
        this.logger.info("Opening an edit snapshot", { branch: { branchId } });

        const identity = await this.db.$transaction(async (tx) => {
            const branch = await this.lockBranchForOpen(tx, branchId, organizationId);
            const sourceSnapshotId = branch.activeSnapshotId ?? undefined;
            const sourceSnapshot =
                sourceSnapshotId == null
                    ? undefined
                    : await tx.branchSnapshot.findUniqueOrThrow({
                          where: { id: sourceSnapshotId },
                          select: { headSha: true },
                      });
            const headSha = sourceSnapshot?.headSha ?? undefined;

            const created = await tx.branchSnapshot.create({
                data: {
                    branchId,
                    source: EDIT_SNAPSHOT_TRIGGER,
                    headSha,
                    baseSha: headSha,
                    prevSnapshotId: sourceSnapshotId,
                },
                select: { id: true },
            });
            if (sourceSnapshotId != null) {
                await copyForwardSuite({ tx, sourceSnapshotId, targetSnapshotId: created.id });
            }
            await tx.branch.update({ where: { id: branchId }, data: { pendingSnapshotId: created.id } });

            const identity: OpenSnapshotIdentity = {
                snapshotId: created.id,
                branchId,
                applicationId: branch.applicationId,
                organizationId: branch.organizationId,
                trigger: EDIT_SNAPSHOT_TRIGGER,
                headSha,
                baseSha: headSha,
            };
            return identity;
        });

        this.logger.info("Edit snapshot opened", {
            branch: { branchId },
            snapshot: { snapshotId: identity.snapshotId, headSha: identity.headSha, baseSha: identity.baseSha },
        });
        return new OpenSnapshot({ kind: "root", db: this.db }, identity);
    }

    /**
     * Load the handle on a specific still-open snapshot. Addressed by snapshot id - never "whatever
     * is pending on the branch" - so each pipeline activity operates on the exact snapshot its run
     * was started for, even after a newer trigger replaced the branch's pending snapshot.
     *
     * @throws {SnapshotNotFoundError} when the snapshot does not exist on the (optional) organization.
     * @throws {SnapshotNotOpenError} when it exists but already settled.
     */
    public async reopen(snapshotId: string, options?: { organizationId?: string }): Promise<OpenSnapshot> {
        const snapshot = await this.db.branchSnapshot.findUnique({
            where: { id: snapshotId, branch: { organizationId: options?.organizationId } },
            select: {
                status: true,
                source: true,
                headSha: true,
                baseSha: true,
                branchId: true,
                branch: { select: { applicationId: true, organizationId: true } },
            },
        });
        if (snapshot == null) throw new SnapshotNotFoundError(snapshotId);
        if (snapshot.status !== "processing") throw new SnapshotNotOpenError(snapshotId, snapshot.status);

        return new OpenSnapshot(
            { kind: "root", db: this.db },
            {
                snapshotId,
                branchId: snapshot.branchId,
                applicationId: snapshot.branch.applicationId,
                organizationId: snapshot.branch.organizationId,
                trigger: snapshot.source,
                headSha: snapshot.headSha ?? undefined,
                baseSha: snapshot.baseSha ?? undefined,
            },
        );
    }

    /** One snapshot's suite. Pure read: valid for open and terminal snapshots alike. */
    public async read(snapshotId: string): Promise<Suite> {
        return readSuite(this.db, snapshotId);
    }

    /**
     * What several snapshots assign, flat - the read behind comparing a snapshot against its lineage or against
     * the snapshots of branches merging into it. See {@link readAssignments}.
     */
    public async readAssignments(snapshotIds: string[]): Promise<SuiteAssignment[]> {
        return readAssignments(this.db, snapshotIds);
    }

    /** Where each of a snapshot's tests stands. See {@link readLatestRunPerTest}. */
    public async latestRunPerTest(snapshotId: string): Promise<SuiteRun[]> {
        return readLatestRunPerTest(this.db, snapshotId);
    }

    /**
     * The suite changes a snapshot carries relative to the snapshot it was opened from. Pure read:
     * valid for open and terminal snapshots alike, which is what lets a settlement report what a
     * failed run discarded.
     */
    public async changesSince(snapshotId: string): Promise<SuiteChange[]> {
        const snapshot = await this.db.branchSnapshot.findUnique({
            where: { id: snapshotId },
            select: { prevSnapshotId: true },
        });
        if (snapshot == null) throw new SnapshotNotFoundError(snapshotId);
        return computeSuiteChanges(this.db, snapshotId, snapshot.prevSnapshotId ?? undefined);
    }

    /**
     * The suite changes a snapshot carries relative to an explicitly named earlier snapshot, rather than the one it
     * was opened from. What a PR diff view asks: an active snapshot several analyses deep has left its immediate
     * predecessor behind, and the interesting comparison is against the branch's fork point.
     */
    public async changesAgainst(snapshotId: string, comparedToSnapshotId?: string): Promise<SuiteChange[]> {
        return computeSuiteChanges(this.db, snapshotId, comparedToSnapshotId);
    }

    /**
     * Added/removed/updated counts for many snapshots in one query, keyed by snapshot id. See
     * {@link summarizeSuiteChanges} for why this is not {@link changesSince} in a loop.
     */
    public async summarizeChanges(
        comparisons: readonly SnapshotComparison[],
    ): Promise<Map<string, SuiteChangeSummary>> {
        return summarizeSuiteChanges(this.db, comparisons);
    }

    /**
     * The newest non-cancelled, non-twin snapshot per branch, keyed by branch id - "the branch's latest run".
     * Reached by branch id rather than through `activeSnapshotId`/`pendingSnapshotId` because a failed run sits
     * on neither pointer (settlement clears it so the branch is not left blocked).
     */
    public async latestRuns(branchIds: string[]): Promise<Map<string, LatestRun>> {
        if (branchIds.length === 0) return new Map();

        const snapshots = await this.db.branchSnapshot.findMany({
            where: {
                branchId: { in: branchIds },
                status: { not: "cancelled" },
                investigationParent: { is: null },
            },
            orderBy: { createdAt: "desc" },
            distinct: ["branchId"],
            select: { id: true, branchId: true, status: true, headSha: true, createdAt: true },
        });
        return new Map(
            snapshots.map((snapshot) => [
                snapshot.branchId,
                {
                    snapshotId: snapshot.id,
                    status: snapshot.status,
                    headSha: snapshot.headSha ?? undefined,
                    createdAt: snapshot.createdAt,
                },
            ]),
        );
    }

    /**
     * Resolve what a new snapshot on the branch would fork from, with the derived `baseSha` and
     * whether the head is already analyzed. The one deriving site both the API trigger and the
     * run's own open ask, so they cannot disagree.
     */
    public async resolveSource(input: ResolveSourceInput): Promise<ResolvedSnapshotSource> {
        return resolveSnapshotSource(this.db, input);
    }

    /**
     * Take the branch's row lock and read the pointers an open decides from, refusing a branch that already holds
     * an open snapshot. Every opener goes through here, so the one-open-snapshot-per-branch rule is enforced under
     * the lock rather than by each caller checking first.
     */
    private async lockBranchForOpen(tx: Prisma.TransactionClient, branchId: string, organizationId?: string) {
        await tx.$queryRaw`SELECT id FROM branch WHERE id = ${branchId} FOR UPDATE`;

        const branch = await tx.branch.findUnique({
            where: { id: branchId, organizationId },
            select: {
                organizationId: true,
                applicationId: true,
                activeSnapshotId: true,
                pendingSnapshotId: true,
                baseSnapshotId: true,
            },
        });
        if (branch == null) throw new BranchNotFoundError(branchId);
        if (branch.pendingSnapshotId != null) throw new BranchAlreadyOpenError(branchId, branch.pendingSnapshotId);
        return branch;
    }

    /**
     * A source is resolved from the branch's active snapshot before the lock is taken, so a promotion landing in
     * between would leave it describing a lineage the branch has left - and forking from it silently drops
     * everything that promotion carried. This is the compare half: the resolution's view of the branch's active
     * snapshot, checked against what the lock now sees.
     *
     * A source of the branch's own is that active snapshot. A foreign source (main's, inherited) and an open with
     * no prior snapshot both mean the resolution found the branch had none.
     */
    private assertSourceStillCurrent(
        branchId: string,
        activeSnapshotId: string | undefined,
        resolved: { sourceSnapshotId?: string; sourceBranchId?: string },
    ): void {
        const sourceIsOwn = resolved.sourceBranchId === branchId;
        const expected = sourceIsOwn ? resolved.sourceSnapshotId : undefined;
        if (expected === activeSnapshotId) return;

        this.logger.warn("Refusing a source the branch has moved past", {
            branch: { branchId },
            extra: { expectedActiveSnapshotId: expected, actualActiveSnapshotId: activeSnapshotId },
        });
        throw new SourceMovedError(branchId, expected, activeSnapshotId);
    }

    /** The source snapshot's own coordinates, validated against the branch being opened on. */
    private async resolveSourceRow(
        tx: Prisma.TransactionClient,
        branchId: string,
        applicationId: string,
        source: SnapshotSource,
    ): Promise<{ sourceSnapshotId?: string; sourceBranchId?: string; baseSha: string }> {
        if ("noPriorSnapshot" in source) {
            return { baseSha: source.noPriorSnapshot.baseSha };
        }

        const sourceSnapshot = await tx.branchSnapshot.findUnique({
            where: { id: source.snapshotId },
            select: { headSha: true, branchId: true, branch: { select: { applicationId: true } } },
        });
        if (sourceSnapshot == null) throw new SnapshotNotFoundError(source.snapshotId);
        if (sourceSnapshot.branch.applicationId !== applicationId) {
            throw new ForeignSourceSnapshotError(source.snapshotId, branchId);
        }

        const baseSha = deriveBaseSha({
            sourceBelongsToBranch: sourceSnapshot.branchId === branchId,
            sourceHeadSha: sourceSnapshot.headSha ?? undefined,
            fallbackBaseSha: source.fallbackBaseSha,
        });
        if (baseSha == null) throw new NoSnapshotBaseError(branchId);

        return { sourceSnapshotId: source.snapshotId, sourceBranchId: sourceSnapshot.branchId, baseSha };
    }
}
