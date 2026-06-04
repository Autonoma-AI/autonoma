import type { PrismaClient } from "@autonoma/db";
import type { RunContext, RunStepData } from "@autonoma/diffs";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";

export class RunContextLoader {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly storage: StorageProvider,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async load(runId: string): Promise<RunContext> {
        this.logger.info("Loading run context", { runId });

        const run = await this.db.run.findUniqueOrThrow({
            where: { id: runId },
            select: {
                id: true,
                organizationId: true,
                // `run.plan` is the snapshot of the plan this run actually executed,
                // captured at run creation time. Reading it from `assignment.plan`
                // instead would be wrong after any `updatePlan` call (e.g. healing),
                // which re-points `assignment.planId` to a *new* TestPlan row -
                // so the reviewer would otherwise grade the run against a prompt
                // it never saw.
                plan: { select: { prompt: true } },
                assignment: {
                    select: {
                        testCase: { select: { name: true } },
                    },
                },
                outputs: {
                    select: {
                        list: {
                            select: {
                                order: true,
                                output: true,
                                screenshotBefore: true,
                                screenshotAfter: true,
                                stepInput: { select: { interaction: true, params: true } },
                            },
                            orderBy: { order: "asc" },
                        },
                    },
                },
            },
        });

        const outputSteps = run.outputs?.list ?? [];

        const steps: RunStepData[] = outputSteps.map((step) => ({
            order: step.order,
            interaction: step.stepInput.interaction,
            params: step.stepInput.params,
            output: step.output,
            screenshotBeforeKey: step.screenshotBefore ?? undefined,
            screenshotAfterKey: step.screenshotAfter ?? undefined,
        }));

        const lastStep = outputSteps[outputSteps.length - 1];
        const finalScreenshotKey = lastStep?.screenshotAfter ?? lastStep?.screenshotBefore ?? undefined;

        this.logger.info("Run context loaded", { stepCount: steps.length });

        return {
            runId: run.id,
            organizationId: run.organizationId,
            testPlanPrompt: run.plan?.prompt ?? "No test plan prompt available",
            testCaseName: run.assignment.testCase.name,
            steps,
            videoS3Key: `run/${runId}/video.webm`,
            finalScreenshotKey,
        };
    }

    async loadScreenshot(s3Key: string): Promise<Buffer> {
        return this.storage.download(s3Key);
    }

    async downloadVideo(s3Key: string): Promise<Buffer> {
        return this.storage.download(s3Key);
    }
}
