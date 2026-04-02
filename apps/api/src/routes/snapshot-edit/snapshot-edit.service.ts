import type { BillingService } from "@autonoma/billing";
import { ApplicationArchitecture, type PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { CommitDiffHandler } from "@autonoma/test-updates";
import {
    AddTest,
    ApplicationNotFoundError,
    DiscardChange,
    type GenerationProvider,
    RegenerateSteps,
    RemoveTest,
    TestSuiteUpdater,
    UpdateTest,
} from "@autonoma/test-updates";
import { Service } from "../service";

interface AddTestInput {
    name: string;
    plan: string;
    description?: string;
    scenarioId?: string;
}

interface AddTestsInput {
    tests: Array<{ name: string; plan: string; description?: string }>;
    scenarioId?: string;
}

interface UpdateTestInput {
    testCaseId: string;
    plan: string;
    scenarioId?: string;
}

export class SnapshotEditService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly generationProvider: GenerationProvider,
        private readonly commitDiffHandler: CommitDiffHandler,
        private readonly billingService: BillingService,
    ) {
        super();
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

    async getEditSession(branchId: string, organizationId: string) {
        this.logger.info("Getting edit session", { branchId });

        const updater = await this.continueUpdate(branchId, organizationId);
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

    async addTest(branchId: string, input: AddTestInput, organizationId: string) {
        this.logger.info("Adding test to edit session", { branchId, name: input.name });

        const updater = await this.continueUpdate(branchId, organizationId);

        await updater.apply(
            new AddTest({
                name: input.name,
                description: input.description,
                plan: input.plan,
                scenarioId: input.scenarioId,
            }),
        );

        this.logger.info("Test added to edit session", { branchId });
    }

    async addTests(branchId: string, input: AddTestsInput, organizationId: string) {
        this.logger.info("Adding bulk tests to edit session", { branchId, count: input.tests.length });

        const updater = await this.continueUpdate(branchId, organizationId);

        for (const test of input.tests) {
            await updater.apply(
                new AddTest({
                    name: test.name,
                    description: test.description,
                    plan: test.plan,
                    scenarioId: input.scenarioId,
                }),
            );
        }

        this.logger.info("Bulk tests added to edit session", { branchId, count: input.tests.length });
    }

    async updateTest(branchId: string, input: UpdateTestInput, organizationId: string) {
        this.logger.info("Updating test in edit session", { branchId, testCaseId: input.testCaseId });

        const updater = await this.continueUpdate(branchId, organizationId);

        await updater.apply(
            new UpdateTest({
                testCaseId: input.testCaseId,
                plan: input.plan,
                scenarioId: input.scenarioId,
            }),
        );

        this.logger.info("Test updated in edit session", { branchId, testCaseId: input.testCaseId });
    }

    async regenerateSteps(branchId: string, testCaseId: string, organizationId: string) {
        this.logger.info("Regenerating steps for test in edit session", { branchId, testCaseId });

        const updater = await this.continueUpdate(branchId, organizationId);

        await updater.apply(new RegenerateSteps({ testCaseId }));

        this.logger.info("Steps regeneration scheduled for test in edit session", { branchId, testCaseId });
    }

    async removeTest(branchId: string, testCaseId: string, organizationId: string) {
        this.logger.info("Removing test from edit session", { branchId, testCaseId });

        const updater = await this.continueUpdate(branchId, organizationId);

        await updater.apply(new RemoveTest({ testCaseId }));

        this.logger.info("Test removed from edit session", { branchId, testCaseId });
    }

    async discardChange(branchId: string, testCaseId: string, organizationId: string) {
        this.logger.info("Discarding change for test case", { branchId, testCaseId });

        const updater = await this.continueUpdate(branchId, organizationId);

        await updater.apply(new DiscardChange({ testCaseId }));

        this.logger.info("Change discarded for test case", { branchId, testCaseId });
    }

    async discardGeneration(branchId: string, generationId: string, organizationId: string) {
        this.logger.info("Discarding generation", { branchId, generationId });

        const updater = await this.continueUpdate(branchId, organizationId);

        await updater.discardGeneration(generationId);

        this.logger.info("Generation discarded", { branchId, generationId });
    }

    async queueGenerations(branchId: string, organizationId: string) {
        this.logger.info("Queueing generations for edit session", { branchId });

        const updater = await this.continueUpdate(branchId, organizationId);
        const pendingGenerations = await this.db.testGeneration.findMany({
            where: {
                snapshotId: updater.snapshotId,
                status: "pending",
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

        this.logger.info("Generations queued for edit session", { branchId });
    }

    async finalize(branchId: string, organizationId: string) {
        this.logger.info("Finalizing edit session", { branchId });

        const updater = await this.continueUpdate(branchId, organizationId);

        await updater.finalize();

        this.logger.info("Edit session finalized", { branchId });
    }

    async discard(branchId: string, organizationId: string) {
        this.logger.info("Discarding edit session", { branchId });

        const updater = await this.continueUpdate(branchId, organizationId);

        await updater.discard();

        this.logger.info("Edit session discarded", { branchId });
    }

    private async startUpdate(branchId: string, organizationId: string) {
        try {
            return await TestSuiteUpdater.startUpdate({
                db: this.db,
                branchId,
                commitDiffHandler: this.commitDiffHandler,
                jobProvider: this.generationProvider,
                organizationId,
            });
        } catch (error) {
            if (error instanceof ApplicationNotFoundError) throw new NotFoundError("Branch not found");
            throw error;
        }
    }

    private async continueUpdate(branchId: string, organizationId: string) {
        try {
            return await TestSuiteUpdater.continueUpdate({
                db: this.db,
                branchId,
                commitDiffHandler: this.commitDiffHandler,
                jobProvider: this.generationProvider,
                organizationId,
            });
        } catch (error) {
            if (error instanceof ApplicationNotFoundError) throw new NotFoundError("Branch not found");
            throw error;
        }
    }
}
