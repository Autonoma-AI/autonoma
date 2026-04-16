import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { VisualConditionChecker } from "@autonoma/ai";
import type { CostCollector } from "@autonoma/ai";
import { ReplayEngine, type ReplayStep, WaitConditionChecker, createEngineModelRegistry } from "@autonoma/engine";
import type { ReplayWebCommandSpec } from "@autonoma/engine-web";
import { createWebCommands } from "@autonoma/engine-web";
import { WebInstaller } from "@autonoma/engine-web/web-installer";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger } from "@autonoma/logger";
import { chromium } from "playwright";
import type { TestStepData } from "./isolated-utils";

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

export interface LocalReplayInput {
    /** The recorded steps to replay */
    steps: TestStepData[];
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

export interface LocalReplayResult {
    success: boolean;
    reasoning?: string;
    artifactDir: string;
    steps: Array<{
        order: number;
        interaction: string;
        params: unknown;
        output: unknown;
        screenshotBeforeKey?: string;
        screenshotAfterKey?: string;
    }>;
}

function toReplaySteps(steps: TestStepData[]): ReplayStep<ReplayWebCommandSpec>[] {
    return steps.map((step, index) => ({
        index,
        stepData: {
            interaction: step.interaction,
            params: step.params,
        } as ReplayStep<ReplayWebCommandSpec>["stepData"],
        waitCondition: step.waitCondition,
    }));
}

export async function runReplayLocally(input: LocalReplayInput): Promise<LocalReplayResult> {
    const logger = rootLogger.child({ name: "runReplayLocally", testSlug: input.testSlug });

    logger.info("Starting local replay execution", {
        testSlug: input.testSlug,
        url: input.url,
        stepCount: input.steps.length,
        headless: input.headless ?? true,
    });

    setScreenshotConfig({
        screenResolution: DEFAULT_VIEWPORT,
        architecture: "web",
    });

    const artifactDir = join(input.outputDir, input.testSlug);
    await mkdir(artifactDir, { recursive: true });
    await mkdir(join(artifactDir, "screenshots"), { recursive: true });

    logger.info("Launching browser");
    const browser = await chromium.launch({ headless: input.headless ?? true });
    const browserContext = await browser.newContext({
        viewport: DEFAULT_VIEWPORT,
        recordVideo: { dir: os.tmpdir() },
    });

    try {
        const installer = new WebInstaller(browser, browserContext);
        const models = createEngineModelRegistry(input.costCollector);
        const commands = createWebCommands(models);

        const { context, videoRecorder } = await installer.install({ url: input.url });

        const waitChecker = new WaitConditionChecker(
            new VisualConditionChecker({
                model: models.getModel({ model: "fast-visual", tag: "wait-condition-checker" }),
            }),
            context.screen,
        );

        const engine = new ReplayEngine({
            commands,
            context,
            waitChecker,
            eventHandlers: {
                beforeStep: async () => {},
                afterStep: async ({ step, result }) => {
                    const idx = step.index;
                    if (result.screenshotBefore != null) {
                        await writeFile(
                            join(artifactDir, `screenshots/step-${idx}-before.jpeg`),
                            result.screenshotBefore.buffer,
                        );
                    }
                    if (result.screenshotAfter != null) {
                        await writeFile(
                            join(artifactDir, `screenshots/step-${idx}-after.jpeg`),
                            result.screenshotAfter.buffer,
                        );
                    }
                },
                frame: async () => {},
            },
        });

        const replaySteps = toReplaySteps(input.steps);
        const replayResult = await videoRecorder.withRecording(() => engine.replay(replaySteps));

        const steps = replayResult.state.executionResults.map((stepResult, index) => ({
            order: index,
            interaction: stepResult.step.stepData.interaction,
            params: stepResult.step.stepData.params,
            output: stepResult.output,
            screenshotBeforeKey: `screenshots/step-${index}-before.jpeg`,
            screenshotAfterKey: `screenshots/step-${index}-after.jpeg`,
        }));

        logger.info("Replay execution completed", {
            success: replayResult.success,
            stepCount: steps.length,
        });

        return {
            success: replayResult.success,
            reasoning: replayResult.reasoning,
            artifactDir,
            steps,
        };
    } catch (error) {
        logger.error("Replay execution failed with error", error);
        return {
            success: false,
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
