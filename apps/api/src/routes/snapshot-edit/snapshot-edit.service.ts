import type { BillingService } from "@autonoma/billing";
import { ApplicationArchitecture, type PrismaClient, TriggerSource } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import {
    AddTest,
    ApplicationNotFoundError,
    BranchAlreadyHasPendingSnapshotError,
    DiscardChange,
    type GenerationProvider,
    RegenerateSteps,
    RemoveTest,
    SnapshotNotPendingError,
    TestSuiteUpdater,
    UpdateTest,
} from "@autonoma/test-updates";
import { Service } from "../service";
import { AnalysisInFlightError, EditSessionAlreadyOpenError, EditSessionSupersededError } from "./edit-session-errors";

/** The trigger source that marks a snapshot as owned by the manual editor rather than the analysis pipeline. */
const EDIT_SESSION_SOURCE = TriggerSource.MANUAL;

interface AddTestInput {
    name: string;
    plan: string;
    folderId: string;
    description: string;
    scenarioId?: string;
}

interface AddTestsInput {
    tests: Array<{ name: string; plan: string; folderId: string; description: string }>;
    scenarioId?: string;
}

interface UpdateTestInput {
    testCaseId: string;
    plan: string;
    scenarioId?: string;
}

/**
 * What the branch's single pending-snapshot slot currently holds, from the editor's point of view. `open` carries
 * the snapshot id every subsequent call addresses, so no operation ever resolves "whatever is pending".
 */
type EditSessionState = { state: "none" } | { state: "open"; snapshotId: string } | { state: "analysis-in-flight" };

export class SnapshotEditService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly generationProvider: GenerationProvider,
        private readonly billingService: BillingService,
    ) {
        super();
    }

    /**
     * Resolves the branch's editing state. This is the only branch-addressed call: it is how a client discovers
     * the snapshot id its session owns, and how it learns that an analysis has taken the slot.
     */
    async getState(branchId: string, organizationId: string): Promise<EditSessionState> {
        this.logger.info("Resolving edit session state", { branchId });

        const branch = await this.db.branch.findUnique({
            where: { id: branchId, organizationId },
            select: { pendingSnapshot: { select: { id: true, status: true, source: true } } },
        });
        if (branch == null) throw new NotFoundError("Branch not found");

        const pending = branch.pendingSnapshot;
        if (pending == null || pending.status !== "processing") {
            this.logger.info("Branch has no open snapshot", { branchId });
            return { state: "none" };
        }

        if (pending.source !== EDIT_SESSION_SOURCE) {
            this.logger.info("Branch's open snapshot belongs to the analysis pipeline", {
                branchId,
                snapshotId: pending.id,
            });
            return { state: "analysis-in-flight" };
        }

        this.logger.info("Branch has an open edit session", { branchId, snapshotId: pending.id });
        return { state: "open", snapshotId: pending.id };
    }

    async startEditSession(branchId: string, organizationId: string) {
        this.logger.info("Starting edit session", { branchId });

        const updater = await this.startUpdate(branchId, organizationId);
        const testSuite = await updater.currentTestSuiteInfo();

        this.logger.info("Edit session started", {
            branchId,
            snapshotId: updater.snapshotId,
        });

        return { snapshotId: updater.snapshotId, testSuite };
    }

    async getEditSession(snapshotId: string, organizationId: string) {
        this.logger.info("Getting edit session", { snapshotId });

        const updater = await this.editSession(snapshotId, organizationId);
        const [testSuite, generationSummary, changes] = await Promise.all([
            updater.currentTestSuiteInfo(),
            updater.getGenerationSummary(),
            updater.getChanges(),
        ]);

        return {
            snapshotId: updater.snapshotId,
            testSuite,
            generationSummary,
            changes,
        };
    }

    async addTest(snapshotId: string, input: AddTestInput, organizationId: string) {
        this.logger.info("Adding test to edit session", { snapshotId, name: input.name });

        const updater = await this.editSession(snapshotId, organizationId);

        await updater.apply(
            new AddTest({
                name: input.name,
                description: input.description,
                plan: input.plan,
                folderId: input.folderId,
                scenarioId: input.scenarioId,
            }),
        );

        this.logger.info("Test added to edit session", { snapshotId });
    }

    async addTests(snapshotId: string, input: AddTestsInput, organizationId: string) {
        this.logger.info("Adding bulk tests to edit session", { snapshotId, count: input.tests.length });

        const updater = await this.editSession(snapshotId, organizationId);

        for (const test of input.tests) {
            await updater.apply(
                new AddTest({
                    name: test.name,
                    description: test.description,
                    plan: test.plan,
                    folderId: test.folderId,
                    scenarioId: input.scenarioId,
                }),
            );
        }

        this.logger.info("Bulk tests added to edit session", { snapshotId, count: input.tests.length });
    }

    async updateTest(snapshotId: string, input: UpdateTestInput, organizationId: string) {
        this.logger.info("Updating test in edit session", { snapshotId, testCaseId: input.testCaseId });

        const updater = await this.editSession(snapshotId, organizationId);

        await updater.apply(
            new UpdateTest({
                testCaseId: input.testCaseId,
                plan: input.plan,
                scenarioId: input.scenarioId,
            }),
        );

        this.logger.info("Test updated in edit session", { snapshotId, testCaseId: input.testCaseId });
    }

    async regenerateSteps(snapshotId: string, testCaseId: string, organizationId: string) {
        this.logger.info("Regenerating steps for test in edit session", { snapshotId, testCaseId });

        const updater = await this.editSession(snapshotId, organizationId);

        await updater.apply(new RegenerateSteps({ testCaseId }));

        this.logger.info("Steps regeneration scheduled for test in edit session", { snapshotId, testCaseId });
    }

    async removeTest(snapshotId: string, testCaseId: string, organizationId: string) {
        this.logger.info("Removing test from edit session", { snapshotId, testCaseId });

        const updater = await this.editSession(snapshotId, organizationId);

        await updater.apply(new RemoveTest({ testCaseId }));

        this.logger.info("Test removed from edit session", { snapshotId, testCaseId });
    }

    async discardChange(snapshotId: string, testCaseId: string, organizationId: string) {
        this.logger.info("Discarding change for test case", { snapshotId, testCaseId });

        const updater = await this.editSession(snapshotId, organizationId);

        await updater.apply(new DiscardChange({ testCaseId }));

        this.logger.info("Change discarded for test case", { snapshotId, testCaseId });
    }

    async discardGeneration(snapshotId: string, generationId: string, organizationId: string) {
        this.logger.info("Discarding generation", { snapshotId, generationId });

        const updater = await this.editSession(snapshotId, organizationId);

        await updater.discardGeneration(generationId);

        this.logger.info("Generation discarded", { snapshotId, generationId });
    }

    async queueGenerations(snapshotId: string, organizationId: string) {
        this.logger.info("Queueing generations for edit session", { snapshotId });

        const updater = await this.editSession(snapshotId, organizationId);
        const pendingGenerations = await this.db.testGeneration.findMany({
            where: {
                snapshotId: updater.snapshotId,
                status: "pending",
                // Never queue/charge for investigation shadow generations - they are provisioned separately.
                shadow: false,
            },
            select: {
                id: true,
                testPlan: {
                    select: {
                        testCase: {
                            select: {
                                application: {
                                    select: { architecture: true },
                                },
                            },
                        },
                    },
                },
            },
        });

        const webCount = pendingGenerations.filter(
            (generation) => generation.testPlan.testCase.application.architecture === ApplicationArchitecture.WEB,
        ).length;
        const iosCount = pendingGenerations.filter(
            (generation) => generation.testPlan.testCase.application.architecture === ApplicationArchitecture.IOS,
        ).length;
        const androidCount = pendingGenerations.filter(
            (generation) => generation.testPlan.testCase.application.architecture === ApplicationArchitecture.ANDROID,
        ).length;

        if (webCount > 0) {
            await this.billingService.checkCreditsGate(organizationId, webCount, ApplicationArchitecture.WEB);
        }
        if (iosCount > 0) {
            await this.billingService.checkCreditsGate(organizationId, iosCount, ApplicationArchitecture.IOS);
        }
        if (androidCount > 0) {
            await this.billingService.checkCreditsGate(organizationId, androidCount, ApplicationArchitecture.ANDROID);
        }

        for (const generation of pendingGenerations) {
            await this.billingService.deductCreditsForGeneration(generation.id, {
                organizationId,
                architecture: generation.testPlan.testCase.application.architecture,
            });
        }

        await updater.queuePendingGenerations();

        this.logger.info("Generations queued for edit session", { snapshotId });
    }

    async finalize(snapshotId: string, organizationId: string) {
        this.logger.info("Finalizing edit session", { snapshotId });

        const updater = await this.editSession(snapshotId, organizationId);

        await updater.finalize();

        this.logger.info("Edit session finalized", { snapshotId });
    }

    async discard(snapshotId: string, organizationId: string) {
        this.logger.info("Discarding edit session", { snapshotId });

        const updater = await this.editSession(snapshotId, organizationId);

        await updater.cancel();

        this.logger.info("Edit session discarded", { snapshotId });
    }

    private async startUpdate(branchId: string, organizationId: string) {
        // A manual edit does not advance the branch's commit, so the new snapshot
        // represents the same head as the current active snapshot and contains no
        // code diff. Carry the active snapshot's headSha forward as both headSha and
        // baseSha so that the next diffs trigger keeps using it as the base instead
        // of falling back to the PR base sha.
        const headSha = await this.activeSnapshotHeadSha(branchId);
        try {
            return await TestSuiteUpdater.startUpdate({
                db: this.db,
                branchId,
                jobProvider: this.generationProvider,
                organizationId,
                source: EDIT_SESSION_SOURCE,
                headSha,
                baseSha: headSha,
            });
        } catch (error) {
            if (error instanceof ApplicationNotFoundError) throw new NotFoundError("Branch not found");
            if (error instanceof BranchAlreadyHasPendingSnapshotError) {
                throw await this.pendingSlotTaken(branchId, organizationId);
            }
            throw error;
        }
    }

    private async activeSnapshotHeadSha(branchId: string): Promise<string | undefined> {
        const branch = await this.db.branch.findUnique({
            where: { id: branchId },
            select: { activeSnapshot: { select: { headSha: true } } },
        });
        return branch?.activeSnapshot?.headSha ?? undefined;
    }

    /**
     * Loads the snapshot the caller's session opened, refusing anything the editor does not own.
     *
     * Addressing by id rather than by branch is what makes a superseded session fail instead of silently adopting
     * the winner's snapshot: a superseded snapshot is no longer `processing`, so it cannot be read or written.
     */
    private async editSession(snapshotId: string, organizationId: string): Promise<TestSuiteUpdater> {
        const updater = await this.loadSnapshot(snapshotId, organizationId);

        if (updater.source !== EDIT_SESSION_SOURCE) {
            this.logger.warn("Refusing an edit operation on an analysis snapshot", {
                snapshotId,
                extra: { source: updater.source },
            });
            throw new AnalysisInFlightError();
        }

        return updater;
    }

    private async loadSnapshot(snapshotId: string, organizationId: string): Promise<TestSuiteUpdater> {
        try {
            return await TestSuiteUpdater.continueUpdateBySnapshot({
                db: this.db,
                snapshotId,
                jobProvider: this.generationProvider,
                organizationId,
            });
        } catch (error) {
            if (error instanceof SnapshotNotPendingError) {
                this.logger.warn("Edit session snapshot is no longer open", { snapshotId, extra: { error } });
                throw new EditSessionSupersededError();
            }
            throw error;
        }
    }

    /** Names whoever holds the branch's pending slot, so the caller is told which of the two it lost to. */
    private async pendingSlotTaken(branchId: string, organizationId: string) {
        const state = await this.getState(branchId, organizationId);
        return state.state === "open" ? new EditSessionAlreadyOpenError() : new AnalysisInFlightError();
    }
}
