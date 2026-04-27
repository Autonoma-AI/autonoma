import { writeFileSync } from "node:fs";
import { CostCollector, VisualConditionChecker } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { createEngineModelRegistry, RunPersister, WaitConditionChecker } from "@autonoma/engine";
import { logger as rootLogger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { MobileInstaller } from "../platform";
import type { ReplayMobileCommandSpec } from "./mobile-command-spec";
import { createMobileCommands } from "./mobile-commands";
import { MobileRunAPIRunner } from "./run-api-runner";

const VIDEO_EXTENSION = "mp4";

export async function runMobileReplayJob(runId: string) {
    const logger = rootLogger.child({ name: "run-replay-job", runId });

    const storageProvider = S3Storage.createFromEnv();
    const runPersister = new RunPersister<ReplayMobileCommandSpec>({
        db,
        storageProvider,
        runId,
        videoExtension: VIDEO_EXTENSION,
    });

    let installer: MobileInstaller | undefined;
    let runner: MobileRunAPIRunner | undefined;

    try {
        const run = await db.run.findFirstOrThrow({
            where: { id: runId },
            select: {
                assignment: {
                    select: {
                        testCase: {
                            select: { application: { select: { architecture: true } } },
                        },
                    },
                },
            },
        });

        const architecture = run.assignment.testCase.application.architecture;
        if (architecture === "WEB") throw new Error("Web architecture is not supported for mobile replay");

        const costCollector = new CostCollector();
        const models = createEngineModelRegistry(costCollector);
        const commands = createMobileCommands(models);

        installer = MobileInstaller.fromEnv(architecture, runId);

        runner = new MobileRunAPIRunner({
            storageProvider,
            installer,
            commands,
            createWaitChecker: (screen) =>
                new WaitConditionChecker(
                    new VisualConditionChecker({
                        model: models.getModel({ model: "smart-visual", tag: "wait-condition-checker" }),
                    }),
                    screen,
                ),
            videoExtension: VIDEO_EXTENSION,
            runPersister,
        });

        await runner.runReplay();
        logger.info("Run replay job completed");
    } catch (error) {
        logger.error("Run replay job failed", error);

        try {
            await runPersister.markFailed();
        } catch (markFailedError) {
            logger.error("Failed to mark run as failed", markFailedError);
        }

        throw error;
    } finally {
        try {
            await runner?.cleanupPhotoFiles();
        } catch (error) {
            logger.error("Failed to cleanup tmp photo files", error);
        }

        if (installer != null) {
            try {
                await installer.cleanup();
            } catch (error) {
                logger.error("Failed to cleanup installer", error);
            }
        }

        try {
            writeFileSync("/tmp/flag/done", "");
        } catch (error) {
            logger.error("Failed to write flag file", error);
        }
    }
}
