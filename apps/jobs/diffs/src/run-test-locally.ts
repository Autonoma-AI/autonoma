import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { CostCollector } from "@autonoma/ai";
import { LocalRunner, createEngineModelRegistry } from "@autonoma/engine";
import { createWebAgentFactory } from "@autonoma/engine-web/web-agent-factory";
import { WebInstaller } from "@autonoma/engine-web/web-installer";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger } from "@autonoma/logger";
import { chromium } from "playwright";

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

export interface LocalTestExecutionInput {
    /** The test instruction (prompt) */
    instruction: string;
    /** The URL to test against */
    url: string;
    /** Test name/slug for artifact naming */
    testSlug: string;
    /** Directory to write artifacts to */
    outputDir: string;
    /** Headless browser mode (default: true) */
    headless?: boolean;
    /** Optional cost collector for tracking model usage */
    costCollector?: CostCollector;
}

export interface LocalTestExecutionResult {
    success: boolean;
    finishReason: "success" | "max_steps" | "error";
    reasoning?: string;
    artifactDir: string;
    steps: Array<{
        order: number;
        interaction: string;
        params: unknown;
        output: unknown;
        waitCondition?: string;
        screenshotBeforeKey?: string;
        screenshotAfterKey?: string;
    }>;
}

export async function runTestLocally(input: LocalTestExecutionInput): Promise<LocalTestExecutionResult> {
    const logger = rootLogger.child({ name: "runTestLocally", testSlug: input.testSlug });

    logger.info("Starting local test execution", {
        testSlug: input.testSlug,
        url: input.url,
        headless: input.headless ?? true,
    });

    setScreenshotConfig({
        screenResolution: DEFAULT_VIEWPORT,
        architecture: "web",
    });

    const artifactDir = join(input.outputDir, input.testSlug);
    await mkdir(artifactDir, { recursive: true });

    const tempTestFile = join(artifactDir, "_test-case.md");
    await writeFile(tempTestFile, `---\nurl: ${input.url}\n---\n\n${input.instruction}`, "utf-8");

    logger.info("Launching browser");
    const browser = await chromium.launch({ headless: input.headless ?? true });
    const browserContext = await browser.newContext({
        viewport: DEFAULT_VIEWPORT,
        recordVideo: { dir: os.tmpdir() },
    });

    try {
        const installer = new WebInstaller(browser, browserContext);
        const models = createEngineModelRegistry(input.costCollector);
        const factory = createWebAgentFactory(models);

        const runner = new LocalRunner({
            installer,
            executionAgentFactory: factory,
            eventHandlers: {
                beforeStep: async () => {},
                afterStep: async () => {},
                frame: async () => {},
            },
            videoExtension: "webm",
            artifactDir,
        });

        const executionResult = await runner.runLocalExecution(tempTestFile);

        const steps = executionResult.generatedSteps.map(({ executionOutput, waitCondition }, index) => ({
            order: index,
            interaction: executionOutput.stepData.interaction,
            params: executionOutput.stepData.params,
            output: executionOutput.result,
            waitCondition,
            screenshotBeforeKey: `screenshots/step-${index}-before.jpeg`,
            screenshotAfterKey: `screenshots/step-${index}-after.jpeg`,
        }));

        logger.info("Test execution completed", {
            success: executionResult.success,
            finishReason: executionResult.finishReason,
            stepCount: steps.length,
        });

        return {
            success: executionResult.success,
            finishReason: executionResult.finishReason,
            reasoning: executionResult.reasoning,
            artifactDir,
            steps,
        };
    } catch (error) {
        logger.error("Test execution failed with error", error);
        return {
            success: false,
            finishReason: "error",
            reasoning: error instanceof Error ? error.message : String(error),
            artifactDir,
            steps: [],
        };
    } finally {
        await browser.close().catch((error: unknown) => {
            logger.error("Failed to close browser", error);
        });
    }
}
