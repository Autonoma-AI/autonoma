import "dotenv/config";
import { writeFileSync } from "node:fs";
import { CostCollector } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { GenerationPersister, createEngineModelRegistry } from "@autonoma/engine";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger, runWithSentry } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { MobileInstaller } from "../../platform";
import { type MobileCommandSpec, createMobileAgentFactory } from "../mobile-agent";
import { MobileGenerationAPIRunner } from "./mobile-generation-api-runner";

const DEFAULT_RESOLUTION = { width: 1440, height: 2560 };
const VIDEO_EXTENSION = "mp4";

export async function runMobileGenerationJob(testGenerationId: string) {
    const logger = rootLogger.child({ name: "run-generation-job", testGenerationId });

    setScreenshotConfig({
        screenResolution: DEFAULT_RESOLUTION,
        architecture: "mobile",
    });

    const storageProvider = S3Storage.createFromEnv();
    const generationPersister = new GenerationPersister<MobileCommandSpec>({
        db,
        storageProvider,
        testGenerationId,
        videoExtension: VIDEO_EXTENSION,
    });

    let installer: MobileInstaller | undefined;
    let runner: MobileGenerationAPIRunner | undefined;

    try {
        const generation = await db.testGeneration.findUniqueOrThrow({
            where: { id: testGenerationId },
            select: {
                testPlan: { select: { testCase: { select: { application: { select: { architecture: true } } } } } },
            },
        });
        const architecture = generation.testPlan.testCase.application.architecture;
        if (architecture === "WEB") throw new Error("Web architecture is not supported for mobile generation");

        const costCollector = new CostCollector();
        const models = createEngineModelRegistry(costCollector);
        installer = MobileInstaller.fromEnv(architecture, testGenerationId);

        runner = new MobileGenerationAPIRunner({
            storageProvider,
            installer,
            executionAgentFactory: createMobileAgentFactory(models),
            videoExtension: VIDEO_EXTENSION,
            generationPersister,
            costCollector,
        });

        await runner.runGeneration();
        logger.info("Generation job completed");
    } catch (error) {
        logger.error("Generation job failed", error);

        try {
            const reason = error instanceof Error ? error.message : "Unknown error";
            await generationPersister.markFailed(reason);
        } catch (markFailedError) {
            logger.error("Failed to mark generation as failed", markFailedError);
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

if (process.argv[1]?.includes("run-generation-job")) {
    const args = process.argv.slice(2);
    if (args.length !== 1) {
        console.error("Usage: tsx src/generation-api/run-generation-job.ts <testGenerationId>");
        process.exit(1);
    }

    // biome-ignore lint/style/noNonNullAssertion: Length === 1
    const testGenerationId = args[0]!;

    await runWithSentry({ name: "execution-agent-mobile", tags: { generation_id: testGenerationId } }, () =>
        runMobileGenerationJob(testGenerationId),
    );
}
