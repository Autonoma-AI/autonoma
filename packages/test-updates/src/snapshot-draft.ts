import crypto from "node:crypto";
import type { Prisma, PrismaClient, TriggerSource } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { toSlug } from "@autonoma/utils";
import type { AddTestParams, UpdateTestParams } from "./changes";
import { createBranchSnapshot } from "./queries/create-branch-snapshot";
import { getChangesForSnapshot, type SnapshotChange } from "./queries/snapshot-changes";

export type { SnapshotChange } from "./queries/snapshot-changes";
import { fetchTestSuiteInfo } from "./queries/fetch-info";

export class SnapshotNotPendingError extends Error {
    constructor(snapshotId: string, status: string) {
        super(`Snapshot ${snapshotId} is not a pending snapshot (status: ${status})`);
        this.name = "SnapshotNotPendingError";
    }
}

export class BranchAlreadyHasPendingSnapshotError extends Error {
    constructor(branchId: string) {
        super(`Branch ${branchId} already has a pending snapshot`);
    }
}

export class ApplicationNotFoundError extends Error {
    constructor(branchId: string) {
        super(`Branch ${branchId} not found or does not belong to the specified organization`);
        this.name = "ApplicationNotFoundError";
    }
}

export class StepsPlanMismatchError extends Error {
    constructor(stepsId: string, stepsPlanId: string, assignmentPlanId: string | undefined) {
        super(
            `StepInputList ${stepsId} belongs to plan ${stepsPlanId} but assignment has plan ${assignmentPlanId ?? "none"}`,
        );
    }
}

export type TestSuiteInfo = Awaited<ReturnType<SnapshotDraft["currentTestSuiteInfo"]>>;

interface SnapshotDraftParams {
    db: PrismaClient;
    snapshotId: string;
    branchId: string;
    applicationId: string;
    organizationId: string;
    headSha?: string;
    baseSha?: string;
}

interface LoadSnapshotDraftParams {
    db: PrismaClient;
    branchId: string;
    organizationId?: string;
}

interface LoadSnapshotDraftByIdParams {
    db: PrismaClient;
    snapshotId: string;
    organizationId?: string;
}

interface StartSnapshotDraftParams extends LoadSnapshotDraftParams {
    source?: TriggerSource;
    headSha?: string;
    baseSha?: string;
}

/**
 * Manages mutations on a pending (processing) branch snapshot.
 *
 * Instances are obtained via the static factories `fromBranch` or `start` - both
 * guarantee the underlying snapshot is in the "processing" state and linked as
 * the pending snapshot on its branch.
 */
export class SnapshotDraft {
    private readonly logger: Logger;

    private readonly db: PrismaClient;
    public readonly snapshotId: string;
    public readonly branchId: string;
    public readonly applicationId: string;
    public readonly organizationId: string;
    public readonly headSha?: string;
    public readonly baseSha?: string;

    private constructor({
        db,
        snapshotId,
        applicationId,
        organizationId,
        headSha,
        baseSha,
        branchId,
    }: SnapshotDraftParams) {
        this.logger = rootLogger.child({ name: this.constructor.name, snapshotId });
        this.db = db;
        this.snapshotId = snapshotId;
        this.branchId = branchId;
        this.applicationId = applicationId;
        this.organizationId = organizationId;
        this.headSha = headSha;
        this.baseSha = baseSha;
    }

    /**
     * Loads the pending snapshot for a branch, verifying it exists and is still pending.
     *
     * @throws {ApplicationNotFoundError} If the branch does not exist on the organization.
     * @throws {SnapshotNotPendingError} If the branch has no pending snapshot or it is
     *   not in "processing" status.
     */
    static async loadPending({ db, branchId, organizationId: filterOrgId }: LoadSnapshotDraftParams) {
        const branch = await db.branch.findUnique({
            where: { id: branchId, organizationId: filterOrgId },
            select: {
                organizationId: true,
                applicationId: true,
                pendingSnapshot: { select: { id: true, status: true, headSha: true, baseSha: true } },
            },
        });

        if (branch == null) throw new ApplicationNotFoundError(branchId);

        if (branch.pendingSnapshot == null) {
            throw new SnapshotNotPendingError(branchId, "no pending snapshot");
        }

        const { id: snapshotId, status, headSha, baseSha } = branch.pendingSnapshot;

        if (status !== "processing") {
            throw new SnapshotNotPendingError(snapshotId, status);
        }

        const { organizationId, applicationId } = branch;

        return new SnapshotDraft({
            db,
            snapshotId,
            branchId,
            applicationId,
            organizationId,
            headSha: headSha ?? undefined,
            baseSha: baseSha ?? undefined,
        });
    }

    /**
     * Loads a specific pending snapshot by its ID, verifying it is still pending.
     *
     * Unlike `loadPending`, this does not depend on the branch's current pending
     * snapshot pointer - it loads whichever snapshot is requested, as long as it
     * is still in "processing" status. Used by the diffs workflow so that each
     * activity operates on the exact snapshot the workflow was started for, even
     * if a newer trigger has since replaced the branch's pending snapshot.
     *
     * @throws {SnapshotNotPendingError} If the snapshot does not exist or is not in
     *   "processing" status.
     */
    static async loadById({ db, snapshotId, organizationId: filterOrgId }: LoadSnapshotDraftByIdParams) {
        const snapshot = await db.branchSnapshot.findUnique({
            where: { id: snapshotId, branch: { organizationId: filterOrgId } },
            select: {
                id: true,
                status: true,
                headSha: true,
                baseSha: true,
                branchId: true,
                branch: { select: { applicationId: true, organizationId: true } },
            },
        });

        if (snapshot == null) {
            throw new SnapshotNotPendingError(snapshotId, "not found");
        }

        if (snapshot.status !== "processing") {
            throw new SnapshotNotPendingError(snapshotId, snapshot.status);
        }

        return new SnapshotDraft({
            db,
            snapshotId: snapshot.id,
            branchId: snapshot.branchId,
            applicationId: snapshot.branch.applicationId,
            organizationId: snapshot.branch.organizationId,
            headSha: snapshot.headSha ?? undefined,
            baseSha: snapshot.baseSha ?? undefined,
        });
    }

    /**
     * Creates a new pending snapshot for a branch and copies test case
     * assignments from the branch's current active snapshot. For a brand
     * new branch with no active snapshot, falls back to the application's main
     * branch active snapshot so that new PR branches inherit the live suite.
     *
     * @throws {BranchAlreadyHasPendingSnapshotError} If the branch already has a pending snapshot.
     */
    static async start({
        db,
        branchId,
        organizationId: filterOrgId,
        source,
        headSha,
        baseSha,
    }: StartSnapshotDraftParams): Promise<SnapshotDraft> {
        const logger = rootLogger.child({ name: "SnapshotDraft", branchId });

        const { snapshotId, applicationId, organizationId } = await db.$transaction(async (tx) => {
            logger.info("Locking branch record", { branchId });

            await tx.$queryRaw`SELECT id FROM branch WHERE id = ${branchId} FOR UPDATE`;

            logger.info("Retrieving branch information");

            const branch = await db.branch.findUnique({
                where: { id: branchId, organizationId: filterOrgId },
                select: {
                    pendingSnapshotId: true,
                    activeSnapshotId: true,
                    organizationId: true,
                    applicationId: true,
                    application: {
                        select: {
                            mainBranchId: true,
                            mainBranch: {
                                select: { activeSnapshotId: true },
                            },
                        },
                    },
                },
            });

            if (branch == null) throw new ApplicationNotFoundError(branchId);

            if (branch.pendingSnapshotId != null) {
                logger.fatal("Branch already has a pending snapshot", {
                    branchId,
                    pendingSnapshotId: branch.pendingSnapshotId,
                });
                throw new BranchAlreadyHasPendingSnapshotError(branchId);
            }

            const { snapshotId: createdId } = await createBranchSnapshot({
                tx,
                branchId,
                branch,
                source,
                headSha,
                baseSha,
                logger,
            });

            logger.info("Setting as pending snapshot", { branchId, pendingSnapshotId: createdId });
            await tx.branch.update({
                where: { id: branchId },
                data: { pendingSnapshotId: createdId },
            });

            const { organizationId, applicationId } = branch;

            return { snapshotId: createdId, applicationId, organizationId };
        });

        return new SnapshotDraft({ db, snapshotId, branchId, applicationId, organizationId });
    }

    /**
     * Retrieves information about the test cases currently assigned in this snapshot,
     * including their associated plans and steps.
     */
    public async currentTestSuiteInfo() {
        return fetchTestSuiteInfo(this.db, this.snapshotId);
    }

    /**
     * Compares the assignments in this pending snapshot against the previous
     * (active) snapshot and returns a list of changes.
     *
     * Changes are inferred by comparing test case assignments by `testCaseId`:
     * - Present in pending but not previous -> "added"
     * - Present in previous but not pending -> "removed"
     * - Present in both but `planId` differs -> "updated"
     * - Same `planId` in both -> unchanged (omitted)
     */
    public async getChanges(): Promise<SnapshotChange[]> {
        const snapshot = await this.db.branchSnapshot.findUniqueOrThrow({
            where: { id: this.snapshotId },
            select: { prevSnapshotId: true },
        });
        return getChangesForSnapshot(this.db, this.snapshotId, snapshot.prevSnapshotId, this.logger);
    }

    /** Clears the steps for a test case, keeping the current plan. Returns the current planId. */
    public async clearSteps(testCaseId: string) {
        this.logger.info("Clearing steps for test case", { testCaseId });

        const assignment = await this.db.testCaseAssignment.findUniqueOrThrow({
            where: { snapshotId_testCaseId: { snapshotId: this.snapshotId, testCaseId } },
            select: { planId: true },
        });

        if (assignment.planId == null) {
            throw new Error(`Test case ${testCaseId} has no plan assigned`);
        }

        await this.db.testCaseAssignment.update({
            where: { snapshotId_testCaseId: { snapshotId: this.snapshotId, testCaseId } },
            data: { stepsId: null },
        });

        this.logger.info("Steps cleared for test case", { testCaseId, planId: assignment.planId });

        return { planId: assignment.planId };
    }

    /** Updates the test plan for a test case and clears its steps (now stale). */
    public async updatePlan({ testCaseId, plan, scenarioId }: UpdateTestParams) {
        this.logger.info("Updating plan for test case", { testCaseId, scenarioId });

        const { planId } = await this.db.$transaction(async (tx) => {
            this.logger.info("Creating plan record");

            const { id: planId } = await tx.testPlan.create({
                data: {
                    testCaseId,
                    prompt: plan,
                    scenarioId,
                    organizationId: this.organizationId,
                },
            });

            this.logger.info("Updating test case assignment", { testCaseId });
            await tx.testCaseAssignment.update({
                where: { snapshotId_testCaseId: { snapshotId: this.snapshotId, testCaseId } },
                data: { planId, stepsId: undefined },
            });

            return { planId };
        });

        this.logger.info("Plan updated and steps cleared for test case", { testCaseId });

        return { planId };
    }

    /**
     * Updates the step list for a test case.
     *
     * @throws {StepsPlanMismatchError} If the step list does not belong to the
     *   plan currently assigned to the test case.
     */
    private async updateSteps(tx: Prisma.TransactionClient, testCaseId: string, stepsId: string) {
        this.logger.info("Updating steps for test case", { testCaseId, stepsId });

        const assignment = await tx.testCaseAssignment.findUniqueOrThrow({
            where: { snapshotId_testCaseId: { snapshotId: this.snapshotId, testCaseId } },
            select: { planId: true },
        });

        const stepList = await tx.stepInputList.findUniqueOrThrow({
            where: { id: stepsId },
            select: { planId: true },
        });

        if (stepList.planId !== assignment.planId) {
            this.logger.error("Step list does not match assignment plan", {
                testCaseId,
                stepsId,
                stepsPlanId: stepList.planId,
                assignmentPlanId: assignment.planId,
            });
            throw new StepsPlanMismatchError(stepsId, stepList.planId, assignment.planId ?? undefined);
        }

        await tx.testCaseAssignment.update({
            where: { snapshotId_testCaseId: { snapshotId: this.snapshotId, testCaseId } },
            data: { stepsId },
        });

        this.logger.info("Steps updated for test case", { testCaseId });
    }

    /**
     * Reverts a test case to its previous snapshot assignment.
     *
     * If the test existed in the previous snapshot, replaces the current assignment
     * with the previous one. If it was newly added (no previous assignment), deletes
     * the assignment and the test case record itself.
     */
    public async revertTestCase(testCaseId: string) {
        this.logger.info("Reverting test case to previous assignment", { testCaseId });

        await this.db.$transaction(async (tx) => {
            const snapshot = await tx.branchSnapshot.findUniqueOrThrow({
                where: { id: this.snapshotId },
                select: { prevSnapshotId: true },
            });

            // Delete the current pending assignment (if it exists - may already be gone for "removed" changes)
            await tx.testCaseAssignment.deleteMany({
                where: { snapshotId: this.snapshotId, testCaseId },
            });

            // Delete any pending generations for this test case in this snapshot
            await tx.testGeneration.deleteMany({
                where: {
                    snapshotId: this.snapshotId,
                    status: "pending",
                    testPlan: { testCaseId },
                },
            });

            if (snapshot.prevSnapshotId == null) {
                // No previous snapshot - test was newly added, delete the test case
                this.logger.info("No previous snapshot, deleting test case", { testCaseId });
                await tx.testCase.delete({ where: { id: testCaseId } });
                return;
            }

            const previousAssignment = await tx.testCaseAssignment.findUnique({
                where: { snapshotId_testCaseId: { snapshotId: snapshot.prevSnapshotId, testCaseId } },
                select: { planId: true, stepsId: true },
            });

            if (previousAssignment == null) {
                // Test was newly added in this session, delete the test case
                this.logger.info("No previous assignment found, deleting test case", { testCaseId });
                await tx.testCase.delete({ where: { id: testCaseId } });
                return;
            }

            // Restore the previous assignment
            this.logger.info("Restoring previous assignment", { testCaseId });
            await tx.testCaseAssignment.create({
                data: {
                    snapshotId: this.snapshotId,
                    testCaseId,
                    planId: previousAssignment.planId ?? undefined,
                    stepsId: previousAssignment.stepsId ?? undefined,
                },
            });
        });

        this.logger.info("Test case reverted", { testCaseId });
    }

    private generateRandomSuffix(): string {
        return crypto.randomBytes(4).toString("hex");
    }

    private async generateTestCaseSlug(name: string): Promise<string> {
        const baseSlug = toSlug(name);
        const existing = await this.db.testCase.findFirst({
            where: { applicationId: this.applicationId, slug: baseSlug },
            select: { id: true },
        });
        return existing != null ? `${baseSlug}-${this.generateRandomSuffix()}` : baseSlug;
    }

    /** Adds a new test case to this snapshot with an empty assignment (no plan or steps). */
    public async addTestCase({ name, description, plan, folderId, scenarioId, scenarioName }: AddTestParams) {
        const slug = await this.generateTestCaseSlug(name);
        this.logger.info("Adding new test case", { name, slug });

        this.logger.info("Creating test case record", { name, slug });
        const testCase = await this.db.testCase.create({
            data: {
                name,
                slug,
                description,
                folderId,
                organizationId: this.organizationId,
                applicationId: this.applicationId,
                plans: {
                    create: { prompt: plan, organizationId: this.organizationId, scenarioId, scenarioName },
                },
            },
            select: { id: true, plans: true },
        });
        const testCaseId = testCase.id;
        // biome-ignore lint/style/noNonNullAssertion: A single plan was just created
        const planId = testCase.plans[0]!.id;
        this.logger.info("Test case created", { testCaseId, planId });

        this.logger.info("Adding test case to snapshot", { testCaseId });
        await this.db.testCaseAssignment.create({ data: { snapshotId: this.snapshotId, testCaseId, planId } });
        this.logger.info("Test case added to snapshot", { testCaseId });

        return { testCaseId, planId };
    }

    /** Removes a test case from this snapshot by deleting its assignment. */
    public async removeTestCase(testCaseId: string) {
        this.logger.info("Removing test case from snapshot", { testCaseId });
        await this.db.testCaseAssignment.delete({
            where: { snapshotId_testCaseId: { snapshotId: this.snapshotId, testCaseId } },
        });
        this.logger.info("Test case removed from snapshot", { testCaseId });
    }

    /**
     * Marks a test case as quarantined for this snapshot by linking it to the
     * Issue that describes the failure, and clears its replay pointer. The
     * Issue's `kind` is the quarantine reason; if it carries a `bugId`, that's
     * the source Bug. Throws if no assignment exists for (snapshotId, testCaseId).
     */
    public async quarantineTestCase(testCaseId: string, issueId: string) {
        this.logger.info("Quarantining test case", { testCaseId, issueId });
        await this.db.testCaseAssignment.update({
            where: { snapshotId_testCaseId: { snapshotId: this.snapshotId, testCaseId } },
            data: {
                quarantineIssueId: issueId,
                stepsId: null,
            },
        });
        this.logger.info("Test case quarantined", { testCaseId, issueId });
    }

    /**
     * Batch-updates the step list for multiple test cases at once.
     *
     * Each entry maps a test case to its new step input list. Validates that every
     * step list belongs to the plan currently assigned to its test case.
     *
     * @throws {StepsPlanMismatchError} If any step list does not match its assignment's plan.
     */
    public async updateManySteps(updates: ReadonlyArray<{ testCaseId: string; stepsId: string }>) {
        this.logger.info("Batch-updating steps", { count: updates.length });

        await this.db.$transaction(async (tx) => {
            await Promise.all(updates.map(({ testCaseId, stepsId }) => this.updateSteps(tx, testCaseId, stepsId)));
        });

        this.logger.info("Batch step update complete", { count: updates.length });
    }

    /**
     * Transitions this snapshot from pending to active.
     *
     * Marks the previous active snapshot as superseded and updates the branch
     * pointers atomically.
     *
     * @throws {SnapshotNotPendingError} If the snapshot is no longer in "processing"
     *   status or is no longer the pending snapshot on its branch.
     */
    public async activate() {
        this.logger.info("Marking snapshot as active");

        await this.db.$transaction(async (tx) => {
            const snapshot = await tx.branchSnapshot.findUniqueOrThrow({
                where: { id: this.snapshotId },
                select: {
                    status: true,
                    branchId: true,
                    branch: { select: { pendingSnapshotId: true, activeSnapshotId: true } },
                },
            });

            if (snapshot.status !== "processing") {
                this.logger.fatal("Snapshot is not pending and cannot be activated", {
                    snapshotId: this.snapshotId,
                    status: snapshot.status,
                });
                throw new SnapshotNotPendingError(this.snapshotId, snapshot.status);
            }

            if (snapshot.branch.pendingSnapshotId !== this.snapshotId) {
                this.logger.fatal("Snapshot is no longer the pending snapshot on its branch", {
                    snapshotId: this.snapshotId,
                    branchId: snapshot.branchId,
                    branchPendingSnapshotId: snapshot.branch.pendingSnapshotId,
                });
                throw new SnapshotNotPendingError(this.snapshotId, snapshot.status);
            }

            await tx.branchSnapshot.update({
                where: { id: this.snapshotId },
                data: { status: "active" },
            });

            const previousSnapshotId = snapshot.branch.activeSnapshotId;
            if (previousSnapshotId != null) {
                this.logger.info("Marking previous active snapshot as superseded", { previousSnapshotId });
                await tx.branchSnapshot.update({
                    where: { id: previousSnapshotId },
                    data: { status: "superseded" },
                });
            }

            const branchUpdate: { activeSnapshotId: string; pendingSnapshotId: null; lastHandledSha?: string } = {
                activeSnapshotId: this.snapshotId,
                pendingSnapshotId: null,
            };

            if (this.headSha != null) {
                branchUpdate.lastHandledSha = this.headSha;
            }

            this.logger.info("Updating branch to point to new active snapshot and clear pending snapshot", {
                branchId: snapshot.branchId,
                newActiveSnapshotId: this.snapshotId,
                lastHandledSha: this.headSha,
            });
            await tx.branch.update({
                where: { id: snapshot.branchId },
                data: branchUpdate,
            });
            this.logger.info("Snapshot activation complete");
        });
    }

    /**
     * Discards this pending snapshot, removing all its assignments, generations,
     * and clearing the branch pointer.
     */
    public async discard() {
        this.logger.info("Discarding pending snapshot");

        await this.db.$transaction(async (tx) => {
            const snapshot = await tx.branchSnapshot.findUniqueOrThrow({
                where: { id: this.snapshotId },
                select: { status: true, branch: { select: { pendingSnapshotId: true } } },
            });

            if (snapshot.status !== "processing") {
                throw new SnapshotNotPendingError(this.snapshotId, snapshot.status);
            }

            if (snapshot.branch.pendingSnapshotId !== this.snapshotId) {
                throw new SnapshotNotPendingError(this.snapshotId, snapshot.status);
            }

            await tx.testGeneration.deleteMany({ where: { snapshotId: this.snapshotId } });
            await tx.testCaseAssignment.deleteMany({ where: { snapshotId: this.snapshotId } });

            await tx.branch.update({
                where: { id: this.branchId },
                data: { pendingSnapshotId: null },
            });

            await tx.branchSnapshot.delete({ where: { id: this.snapshotId } });
        });

        this.logger.info("Pending snapshot discarded");
    }
}
