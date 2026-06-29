import os from "node:os";
import { CostCollector } from "@autonoma/ai";
import { LocalRunner, createEngineModelRegistry } from "@autonoma/engine";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger } from "@autonoma/logger";
import { chromium } from "playwright";
import { type WebApplicationData, type WebContext, WebInstaller, env } from "../../platform";
import { type WebCommandSpec, createWebAgentFactory } from "../web-agent";
import { printCostSummary } from "./cost-summary";

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

async function main(testCasePath: string) {
    const logger = rootLogger.child({ name: "run-execution" });

    setScreenshotConfig({
        screenResolution: DEFAULT_VIEWPORT,
        architecture: "web",
    });

    logger.debug("Launching browser");
    const browser = await chromium.launch({ headless: env.HEADLESS === "true" });
    const browserContext = await browser.newContext({
        viewport: DEFAULT_VIEWPORT,
        recordVideo: { dir: os.tmpdir() },
    });
    const installer = new WebInstaller(browser, browserContext, env.NATIVE_DIALOGS_ENABLED);

    const costCollector = new CostCollector();

    try {
        const runner = new LocalRunner<WebCommandSpec, WebApplicationData, WebContext>({
            installer,
            executionAgentFactory: createWebAgentFactory(createEngineModelRegistry(costCollector)),
            eventHandlers: {
                beforeStep: async () => {},
                attempt: async () => {},
                frame: async () => {},
            },
            videoExtension: "webm",
        });

        await runner.runLocalExecution(testCasePath);
    } finally {
        try {
            await installer.cleanup();
        } catch (error) {
            logger.fatal("Failed to cleanup browser", error);
        }
        await printCostSummary(costCollector);
    }
}

const args = process.argv.slice(2);
if (args.length !== 1) {
    console.error("Usage: tsx src/local-dev/run-execution.ts <test-case-file>");
    process.exit(1);
}

// biome-ignore lint/style/noNonNullAssertion: Length === 1
const testCasePath = args[0]!;
main(testCasePath).catch((error) => {
    console.error("Unhandled error:", error);
    process.exit(1);
});
