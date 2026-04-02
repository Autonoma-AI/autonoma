import crypto from "node:crypto";
import { type Prisma, type PrismaClient, TriggerSource } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { toSlug } from "@autonoma/utils";
import type { AddSkillParams } from "./changes/add-skill";
import type { AddTestParams } from "./changes/add-test";
import type { UpdateSkillParams } from "./changes/update-skill";
import type { UpdateTestParams } from "./changes/update-test";
import { GenerationManager } from "./generation/generation-manager";

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

interface BaseChange {
    testCaseId: string;
    testCaseName: string;
    testCaseSlug: string;
}

interface AddedChange extends BaseChange {
    type: "added";
    plan: string;
}

interface RemovedChange extends BaseChange {
    type: "removed";
    previousPlan: string;
}

interface UpdatedChange extends BaseChange {
    type: "updated";
    plan: string;
    previousPlan: string;
}

export type SnapshotChange = AddedChange | RemovedChange | UpdatedChange;

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
     * Creates a new pending snapshot for a branch and copies test case
     * assignments from the current active snapshot (if one exists).
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
                    activeSnapshot: { select: { deploymentId: true } },
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

            logger.info("Creating new snapshot", { branchId });
            const created = await tx.branchSnapshot.create({
                data: {
                    branchId,
                    source: source ?? TriggerSource.MANUAL,
                    headSha,
                    baseSha,
                    // TODO: Support different deployments per-snapshot.
                    deploymentId: branch.activeSnapshot?.deploymentId ?? undefined,
                    prevSnapshotId: branch.activeSnapshotId ?? undefined,
                },
                select: { id: true },
            });

            logger.info("Setting as pending snapshot", { branchId, pendingSnapshotId: created.id });
            await tx.branch.update({
                where: { id: branchId },
                data: { pendingSnapshotId: created.id },
            });

            if (branch.activeSnapshotId != null) {
                logger.info("Retrieving active test case assignments", { snapshotId: branch.activeSnapshotId });
                const assignments = await tx.testCaseAssignment.findMany({
                    where: { snapshotId: branch.activeSnapshotId },
                    select: {
                        testCaseId: true,
                        planId: true,
                        stepsId: true,
                        mainAssignmentId: true,
                    },
                });

                if (assignments.length > 0) {
                    logger.info("Copying active snapshot assignments", {
                        snapshotId: branch.activeSnapshotId,
                        assignmentCount: assignments.length,
                    });
                    await tx.testCaseAssignment.createMany({
                        data: assignments.map((a) => ({
                            snapshotId: created.id,
                            testCaseId: a.testCaseId,
                            planId: a.planId ?? undefined,
                            stepsId: a.stepsId ?? undefined,
                            mainAssignmentId: a.mainAssignmentId ?? undefined,
                        })),
                    });
                }

                logger.info("Retrieving active skill assignments", { snapshotId: branch.activeSnapshotId });
                const skillAssignments = await tx.skillAssignment.findMany({
                    where: { snapshotId: branch.activeSnapshotId },
                    select: {
                        skillId: true,
                        planId: true,
                        mainAssignmentId: true,
                    },
                });

                if (skillAssignments.length > 0) {
                    logger.info("Copying active skill assignments", {
                        snapshotId: branch.activeSnapshotId,
                        assignmentCount: skillAssignments.length,
                    });

                    await tx.skillAssignment.createMany({
                        data: skillAssignments.map((a) => ({
                            snapshotId: created.id,
                            skillId: a.skillId,
                            planId: a.planId ?? undefined,
                            mainAssignmentId: a.mainAssignmentId ?? undefined,
                        })),
                    });
                }
            }

            const { organizationId, applicationId } = branch;

            return { snapshotId: created.id, applicationId, organizationId };
        });

        return new SnapshotDraft({ db, snapshotId, branchId, applicationId, organizationId });
    }

    /**
     * Retrieves information about the test cases and skills currently assigned in this snapshot,
     * including their associated plans and steps.
     */
    public async currentTestSuiteInfo() {
        return this.db.$transaction(async (tx) => {
            const testCaseAssignments = await tx.testCaseAssignment.findMany({
                where: { snapshotId: this.snapshotId },
                select: {
                    testCase: {
                        select: {
                            id: true,
                            slug: true,
                            name: true,
                            folderId: true,
                            folder: { select: { name: true } },
                        },
                    },
                    plan: {
                        select: {
                            id: true,
                            prompt: true,
                            scenarioId: true,
                            scenario: { select: { id: true, name: true } },
                        },
                    },
                    steps: { select: { id: true, list: true } },
                },
            });

            const skillAssignments = await tx.skillAssignment.findMany({
                where: { snapshotId: this.snapshotId },
                select: {
                    skillId: true,
                    skill: { select: { id: true, slug: true, name: true, description: true } },
                    planId: true,
                    plan: { select: { content: true } },
                },
            });

            return {
                testCases: testCaseAssignments.map(({ testCase, plan, steps }) => ({
                    id: testCase.id,
                    slug: testCase.slug,
                    name: testCase.name,
                    folderId: testCase.folderId,
                    plan: plan,
                    steps: steps,
                })),
                skills: skillAssignments.map(({ skill, plan }) => ({
                    id: skill.id,
                    slug: skill.slug,
                    name: skill.name,
                    description: skill.description,
                    plan: plan,
                })),
            };
        });
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
        this.logger.info("Computing changes from previous snapshot");

        const snapshot = await this.db.branchSnapshot.findUniqueOrThrow({
            where: { id: this.snapshotId },
            select: { prevSnapshotId: true },
        });

        const assignmentSelect = {
            testCaseId: true,
            planId: true,
            testCase: { select: { id: true, name: true, slug: true } },
            plan: { select: { prompt: true } },
        } as const;

        const pendingAssignments = await this.db.testCaseAssignment.findMany({
            where: { snapshotId: this.snapshotId },
            select: assignmentSelect,
        });

        if (snapshot.prevSnapshotId == null) {
            this.logger.info("No previous snapshot, all assignments are additions", {
                count: pendingAssignments.length,
            });
            return pendingAssignments.map((a) => ({
                type: "added" as const,
                testCaseId: a.testCase.id,
                testCaseName: a.testCase.name,
                testCaseSlug: a.testCase.slug,
                plan: a.plan?.prompt ?? "",
            }));
        }

        const previousAssignments = await this.db.testCaseAssignment.findMany({
            where: { snapshotId: snapshot.prevSnapshotId },
            select: assignmentSelect,
        });

        const previousByTestCaseId = new Map(previousAssignments.map((a) => [a.testCaseId, a]));
        const pendingByTestCaseId = new Map(pendingAssignments.map((a) => [a.testCaseId, a]));

        const changes: SnapshotChange[] = [];

        for (const [testCaseId, pending] of pendingByTestCaseId) {
            const previous = previousByTestCaseId.get(testCaseId);

            if (previous == null) {
                changes.push({
                    type: "added",
                    testCaseId: pending.testCase.id,
                    testCaseName: pending.testCase.name,
                    testCaseSlug: pending.testCase.slug,
                    plan: pending.plan?.prompt ?? "",
                });
            } else if (pending.planId !== previous.planId) {
                changes.push({
                    type: "updated",
                    testCaseId: pending.testCase.id,
                    testCaseName: pending.testCase.name,
                    testCaseSlug: pending.testCase.slug,
                    plan: pending.plan?.prompt ?? "",
                    previousPlan: previous.plan?.prompt ?? "",
                });
            }
        }

        for (const [testCaseId, previous] of previousByTestCaseId) {
            if (!pendingByTestCaseId.has(testCaseId)) {
                changes.push({
                    type: "removed",
                    testCaseId: previous.testCase.id,
                    testCaseName: previous.testCase.name,
                    testCaseSlug: previous.testCase.slug,
                    previousPlan: previous.plan?.prompt ?? "",
                });
            }
        }

        this.logger.info("Changes computed", { count: changes.length });

        return changes;
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
                select: { planId: true, stepsId: true, mainAssignmentId: true },
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
                    mainAssignmentId: previousAssignment.mainAssignmentId ?? undefined,
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

    private async generateSkillSlug(name: string): Promise<string> {
        const baseSlug = toSlug(name);
        const existing = await this.db.skill.findFirst({
            where: { applicationId: this.applicationId, slug: baseSlug },
            select: { id: true },
        });
        return existing != null ? `${baseSlug}-${this.generateRandomSuffix()}` : baseSlug;
    }

    /** Adds a new test case to this snapshot with an empty assignment (no plan or steps). */
    public async addTestCase({ name, description, plan, scenarioId }: AddTestParams) {
        const slug = await this.generateTestCaseSlug(name);
        this.logger.info("Adding new test case", { name, slug });

        this.logger.info("Creating test case record", { name, slug });
        const testCase = await this.db.testCase.create({
            data: {
                name,
                slug,
                description,
                organizationId: this.organizationId,
                applicationId: this.applicationId,
                plans: {
                    create: { prompt: plan, organizationId: this.organizationId, scenarioId },
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

    /** Adds a new skill to this snapshot with an initial plan. */
    public async addSkill({ name, description, plan }: AddSkillParams) {
        const slug = await this.generateSkillSlug(name);
        this.logger.info("Adding new skill", { name, slug });

        const skill = await this.db.skill.create({
            data: {
                name,
                slug,
                description,
                organizationId: this.organizationId,
                applicationId: this.applicationId,
                plans: {
                    create: { content: plan, organizationId: this.organizationId },
                },
            },
            select: { id: true, plans: true },
        });
        const skillId = skill.id;
        // biome-ignore lint/style/noNonNullAssertion: A single plan was just created
        const planId = skill.plans[0]!.id;
        this.logger.info("Skill created", { skillId, planId });

        this.logger.info("Adding skill to snapshot", { skillId });
        await this.db.skillAssignment.create({ data: { snapshotId: this.snapshotId, skillId, planId } });
        this.logger.info("Skill added to snapshot", { skillId });

        return { skillId, planId };
    }

    /** Updates the plan for a skill. */
    public async updateSkillPlan({ skillId, plan }: UpdateSkillParams) {
        this.logger.info("Updating plan for skill", { skillId });

        const { id: planId } = await this.db.skillPlan.create({
            data: {
                skillId,
                content: plan,
                organizationId: this.organizationId,
            },
        });

        await this.db.skillAssignment.update({
            where: { snapshotId_skillId: { snapshotId: this.snapshotId, skillId } },
            data: { planId },
        });

        this.logger.info("Skill plan updated", { skillId, planId });

        return { planId };
    }

    /** Removes a skill from this snapshot by deleting its assignment. */
    public async removeSkill(skillId: string) {
        this.logger.info("Removing skill from snapshot", { skillId });
        await this.db.skillAssignment.delete({
            where: { snapshotId_skillId: { snapshotId: this.snapshotId, skillId } },
        });
        this.logger.info("Skill removed from snapshot", { skillId });
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

            this.logger.info("Updating branch to point to new active snapshot and clear pending snapshot", {
                branchId: snapshot.branchId,
                newActiveSnapshotId: this.snapshotId,
            });
            await tx.branch.update({
                where: { id: snapshot.branchId },
                data: {
                    activeSnapshotId: this.snapshotId,
                    pendingSnapshotId: null,
                },
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
            await tx.skillAssignment.deleteMany({ where: { snapshotId: this.snapshotId } });

            await tx.branch.update({
                where: { id: this.branchId },
                data: { pendingSnapshotId: null },
            });

            await tx.branchSnapshot.delete({ where: { id: this.snapshotId } });
        });

        this.logger.info("Pending snapshot discarded");
    }

    public generationManager() {
        return new GenerationManager({
            db: this.db,
            snapshotId: this.snapshotId,
            organizationId: this.organizationId,
        });
    }
}
