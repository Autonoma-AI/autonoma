import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { CostCollector, VisualConditionChecker } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { RunPersister, WaitConditionChecker, createEngineModelRegistry } from "@autonoma/engine";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import type { Browser } from "playwright";
import { DEFAULT_VIEWPORT, connectBrowser } from "../platform/connect-browser";
import { env } from "../platform/env";
import { WebInstaller } from "../platform/web-installer";
import { WebRunAPIRunner } from "./run-api-runner";
import type { ReplayWebCommandSpec } from "./web-command-spec";
import { createWebCommands } from "./web-commands";

const VIDEO_EXTENSION = "webm";

export async function runWebReplayJob(runId: string, urlOverride?: string) {
    const logger = rootLogger.child({ name: "run-replay-job", runId });

    setScreenshotConfig({ screenResolution: DEFAULT_VIEWPORT, architecture: "web" });

    const storageProvider = S3Storage.createFromEnv();
    const runPersister = new RunPersister<ReplayWebCommandSpec>({
        db,
        storageProvider,
        runId,
        videoExtension: VIDEO_EXTENSION,
    });

    let browser: Browser | undefined;
    let browserContext: Awaited<ReturnType<Browser["newContext"]>> | undefined;

    try {
        browser = await connectBrowser();
        browserContext = await browser.newContext({
            viewport: DEFAULT_VIEWPORT,
            recordVideo: { dir: os.tmpdir() },
        });

        const costCollector = new CostCollector();
        const models = createEngineModelRegistry(costCollector);
        const commands = createWebCommands(models);

        const runner = new WebRunAPIRunner({
            installer: new WebInstaller(browser, browserContext, env.NATIVE_DIALOGS_ENABLED),
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
            storageProvider,
            urlOverride,
        });

        await runner.runReplay();
        logger.info("Run replay job completed");
    } catch (error) {
        logger.error("Run replay job failed", error);

        try {
            await runPersister.markFailed(error);
        } catch (markFailedError) {
            logger.error("Failed to mark run as failed", markFailedError);
        }

        throw error;
    } finally {
        try {
            if (browserContext != null) {
                await browserContext.close();
            }
        } catch (error) {
            logger.error("Failed to close browser context", error);
        }

        try {
            if (browser != null) {
                await browser.close();
            }
        } catch (error) {
            logger.error("Failed to close browser", error);
        }

        try {
            mkdirSync("/tmp/flag", { recursive: true });
            writeFileSync("/tmp/flag/done", "");
        } catch (error) {
            logger.error("Failed to write flag file", error);
        }
    }
}
