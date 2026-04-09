import { writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CostCollector } from "@autonoma/ai";
import { db } from "@autonoma/db";
import {
    GenerationAPIRunner,
    GenerationPersister,
    type PlanData,
    type TestCase,
    buildExecutionPrompt,
    buildSkillsConfigFromPlanData,
    createEngineModelRegistry,
} from "@autonoma/engine";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger, runWithSentry } from "@autonoma/logger";
import { S3Storage, type StorageProvider } from "@autonoma/storage";
import { AuthPayloadSchema } from "@autonoma/types";
import { chromium } from "playwright";
import { type WebApplicationData, type WebContext, WebInstaller, connectRemoteBrowser } from "../../platform";
import { env } from "../../platform/env";
import { toPlaywrightCookies } from "../../platform/scenario-auth";
import { type WebCommandSpec, createWebAgentFactory } from "../web-agent";

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const VIDEO_EXTENSION = "webm";
const REMOTE_BROWSER_HEALTH_TIMEOUT_MS = 90_000;
const REMOTE_BROWSER_HEALTH_POLL_MS = 1_000;

async function waitForRemoteBrowserHealth(endpoint: string, logger: ReturnType<typeof rootLogger.child>) {
    const healthUrl =
        endpoint.startsWith("http://") || endpoint.startsWith("https://")
            ? `${endpoint.replace(/\/$/, "")}/json/version`
            : `http://${endpoint.replace(/\/$/, "")}/json/version`;
    const startedAt = Date.now();

    while (Date.now() - startedAt < REMOTE_BROWSER_HEALTH_TIMEOUT_MS) {
        try {
            const response = await fetch(healthUrl);
            if (response.ok) {
                logger.info("Remote browser healthcheck is ready", { healthUrl });
                return;
            }
        } catch {
            // Browser sidecar may still be starting up; keep polling.
        }

        await new Promise((resolve) => setTimeout(resolve, REMOTE_BROWSER_HEALTH_POLL_MS));
    }

    throw new Error(`Remote browser healthcheck timeout after ${REMOTE_BROWSER_HEALTH_TIMEOUT_MS}ms: ${healthUrl}`);
}

class WebGenerationAPIRunner extends GenerationAPIRunner<WebCommandSpec, WebContext, WebApplicationData> {
    private readonly tmpUploadFiles = new Set<string>();
    private readonly uploadLogger = rootLogger.child({ name: "web-generation-upload" });
    private readonly storageProvider: StorageProvider;

    constructor(
        config: ConstructorParameters<typeof GenerationAPIRunner<WebCommandSpec, WebContext, WebApplicationData>>[0] & {
            storageProvider: StorageProvider;
        },
    ) {
        const { storageProvider, ...runnerConfig } = config;
        super(runnerConfig);
        this.storageProvider = storageProvider;
    }

    public async parsePlanData(planData: PlanData): Promise<TestCase & WebApplicationData> {
        const { testPlan, snapshot, scenarioInstance } = planData;
        const application = testPlan.testCase.application;
        const webDeployment = snapshot?.deployment?.webDeployment;
        if (webDeployment == null) {
            throw new Error(`Application "${application.name}" has no web deployment`);
        }
        if (webDeployment.url === "") {
            throw new Error(`Application "${application.name}" has no deployment URL configured`);
        }
        if (webDeployment.file == null) {
            throw new Error(`Application "${application.name}" has no default upload file configured`);
        }

        const file = await this.resolveUploadFilePath(webDeployment.file);

        const skillsConfig = buildSkillsConfigFromPlanData(planData);

        const authParsed = AuthPayloadSchema.safeParse(scenarioInstance?.auth);
        const auth = authParsed.success ? authParsed.data : undefined;
        const cookies = auth?.cookies != null ? toPlaywrightCookies(auth.cookies, webDeployment.url) : undefined;
        const headers = auth?.headers;
        const credentials = auth?.credentials;

        return {
            name: testPlan.testCase.name,
            prompt: buildExecutionPrompt(testPlan.prompt, application.customInstructions, credentials),
            file,
            url: webDeployment.url,
            skillsConfig,
            cookies,
            headers,
            credentials,
        };
    }

    private async resolveUploadFilePath(fileKey: string): Promise<string> {
        this.uploadLogger.info("Downloading upload file from S3", { fileKey });

        const buffer = await this.storageProvider.download(fileKey);

        const filename = `${Date.now()}-${path.basename(fileKey)}`;
        const tmpPath = path.join(os.tmpdir(), filename);

        writeFileSync(tmpPath, buffer);
        this.tmpUploadFiles.add(tmpPath);

        this.uploadLogger.info("Upload file written to tmp path", { tmpPath });

        return tmpPath;
    }

    public async cleanupUploadFiles() {
        for (const tmpFile of this.tmpUploadFiles) {
            try {
                await unlink(tmpFile);
                this.uploadLogger.info("Deleted tmp upload file", { tmpFile });
            } catch (error) {
                this.uploadLogger.warn("Failed to delete tmp upload file", { tmpFile, error });
            }
        }
        this.tmpUploadFiles.clear();
    }
}

async function connectBrowser() {
    const logger = rootLogger.child({ name: "connect-browser" });

    if (env.REMOTE_BROWSER_URL != null) {
        logger.info("Connecting to remote browser", {
            endpoint: env.REMOTE_BROWSER_URL,
        });

        await waitForRemoteBrowserHealth(env.REMOTE_BROWSER_URL, logger);

        const maxAttempts = 10;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await connectRemoteBrowser({
                    remoteChromeEndpoint: env.REMOTE_BROWSER_URL,
                    viewport: DEFAULT_VIEWPORT,
                });
            } catch (error) {
                if (attempt === maxAttempts) throw error;
                logger.warn(`Browser not ready, retrying (${attempt}/${maxAttempts})...`);
                await new Promise((r) => setTimeout(r, 2000));
            }
        }
    }

    logger.info("Launching local browser");
    return await chromium.launch({ headless: env.HEADLESS === "true" });
}

async function main(testGenerationId: string) {
    const logger = rootLogger.child({
        name: "run-generation-job",
        testGenerationId,
    });

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
        const runner = new WebGenerationAPIRunner({
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

const args = process.argv.slice(2);
if (args.length !== 1) {
    console.error("Usage: tsx src/generation-api/run-generation-job.ts <testGenerationId>");
    process.exit(1);
}

// biome-ignore lint/style/noNonNullAssertion: Length === 1
const testGenerationId = args[0]!;

await runWithSentry({ name: "execution-agent-web", tags: { generation_id: testGenerationId } }, () =>
    main(testGenerationId),
);
