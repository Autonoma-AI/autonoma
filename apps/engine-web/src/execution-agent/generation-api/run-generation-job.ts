import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { CostCollector } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { GenerationPersister, createEngineModelRegistry } from "@autonoma/engine";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { WebInstaller, env } from "../../platform";
import { DEFAULT_VIEWPORT, connectBrowser } from "../../platform/connect-browser";
import { createWebAgentFactory } from "../web-agent";
import type { WebCommandSpec } from "../web-agent";
import { WebGenerationAPIRunner } from "./web-generation-api-runner";

const VIDEO_EXTENSION = "webm";

function isStringRecord(value: unknown): value is Record<string, string> {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.values(value).every((v) => typeof v === "string");
}

async function resolveWebhookHeaders(testGenerationId: string): Promise<Record<string, string> | undefined> {
    const generation = await db.testGeneration.findUnique({
        where: { id: testGenerationId },
        select: { snapshot: { select: { branch: { select: { deployment: { select: { webhookHeaders: true } } } } } } },
    });

    const webhookHeaders = generation?.snapshot.branch.deployment?.webhookHeaders;
    return isStringRecord(webhookHeaders) ? webhookHeaders : undefined;
}

export async function runWebGenerationJob(testGenerationId: string, urlOverride?: string, sdkUrlOverride?: string) {
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
        const extraHTTPHeaders = await resolveWebhookHeaders(testGenerationId);
        logger.info("Resolved deployment webhook headers for browser context", {
            headerCount: extraHTTPHeaders != null ? Object.keys(extraHTTPHeaders).length : 0,
        });

        const browser = await connectBrowser();
        const browserContext = await browser.newContext({
            viewport: DEFAULT_VIEWPORT,
            recordVideo: { dir: os.tmpdir() },
            extraHTTPHeaders,
        });
        installer = new WebInstaller(browser, browserContext, env.NATIVE_DIALOGS_ENABLED);

        const costCollector = new CostCollector();
        const models = createEngineModelRegistry(costCollector);
        runner = new WebGenerationAPIRunner({
            storageProvider,
            installer: new WebInstaller(browser, browserContext, env.NATIVE_DIALOGS_ENABLED),
            executionAgentFactory: createWebAgentFactory(models),
            videoExtension: VIDEO_EXTENSION,
            generationPersister,
            costCollector,
            urlOverride,
            sdkUrlOverride,
        });

        await runner.runGeneration();
        logger.info("Generation job completed");
    } catch (error) {
        logger.error("Generation job failed", error);

        try {
            await generationPersister.markFailed(error);
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
            mkdirSync("/tmp/flag", { recursive: true });
            writeFileSync("/tmp/flag/done", "");
        } catch (error) {
            logger.error("Failed to write flag file", error);
        }
    }
}
