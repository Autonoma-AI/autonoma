import { writeFileSync } from "node:fs";
import os from "node:os";
import { CostCollector } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { GenerationPersister, createEngineModelRegistry } from "@autonoma/engine";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger, runWithSentry } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { WebInstaller } from "../../platform";
import { DEFAULT_VIEWPORT, connectBrowser } from "../../platform/connect-browser";
import { createWebAgentFactory } from "../web-agent";
import type { WebCommandSpec } from "../web-agent";
import { WebGenerationAPIRunner } from "./web-generation-api-runner";

const VIDEO_EXTENSION = "webm";

export async function runWebGenerationJob(testGenerationId: string) {
    const logger = rootLogger.child({ name: "run-generation-job", testGenerationId });

    setScreenshotConfig({
        screenResolution: DEFAULT_VIEWPORT,
        architecture: "web",
    });

    const storageProvider = S3Storage.createFromEnv();
    const generationPersister = new GenerationPersister<WebCommandSpec>({
        db,
        storageProvider,
        testGenerationId,
        videoExtension: VIDEO_EXTENSION,
    });

    let runner: WebGenerationAPIRunner | undefined;
    let installer: WebInstaller | undefined;

    try {
        const browser = await connectBrowser();
        const browserContext = await browser.newContext({
            viewport: DEFAULT_VIEWPORT,
            recordVideo: { dir: os.tmpdir() },
        });
        installer = new WebInstaller(browser, browserContext);

        const costCollector = new CostCollector();
        const models = createEngineModelRegistry(costCollector);
        runner = new WebGenerationAPIRunner({
            storageProvider,
            installer: new WebInstaller(browser, browserContext),
            executionAgentFactory: createWebAgentFactory(models),
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
            await runner?.cleanupUploadFiles();
        } catch (error) {
            logger.error("Failed to cleanup tmp upload files", error);
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

    await runWithSentry({ name: "execution-agent-web", tags: { generation_id: testGenerationId } }, () =>
        runWebGenerationJob(testGenerationId),
    );
}
