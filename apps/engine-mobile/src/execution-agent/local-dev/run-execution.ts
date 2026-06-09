import "dotenv/config";
import { CostCollector } from "@autonoma/ai";
import { LocalRunner, createEngineModelRegistry, printCostSummary } from "@autonoma/engine";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger } from "@autonoma/logger";
import { type MobileApplicationData, type MobileContext, MobileInstaller } from "../../platform";
import { type MobileCommandSpec, createMobileAgentFactory } from "../mobile-agent";

const DEFAULT_RESOLUTION = { width: 1440, height: 2560 };

async function main(testCasePath: string) {
    const logger = rootLogger.child({ name: "run-execution" });

    setScreenshotConfig({
        screenResolution: DEFAULT_RESOLUTION,
        architecture: "mobile",
    });

    const installer = new MobileInstaller({});
    const costCollector = new CostCollector();

    try {
        const runner = new LocalRunner<MobileCommandSpec, MobileApplicationData, MobileContext>({
            installer,
            executionAgentFactory: createMobileAgentFactory(createEngineModelRegistry(costCollector)),
            eventHandlers: {
                beforeStep: async () => {},
                attempt: async () => {},
                frame: async () => {},
            },
            videoExtension: "mp4",
        });

        await runner.runLocalExecution(testCasePath);
    } finally {
        printCostSummary(costCollector);
        try {
            await installer.cleanup();
        } catch (error) {
            logger.error("Failed to cleanup installer", error);
        }
    }
}

const args = process.argv.slice(2);
if (args.length !== 1) {
    console.error("Usage: tsx src/execution-agent/local-dev/run-execution.ts <test-case-file>");
    process.exit(1);
}

// biome-ignore lint/style/noNonNullAssertion: Length === 1
const testCasePath = args[0]!;
main(testCasePath).catch((error) => {
    console.error("Unhandled error:", error);
    process.exit(1);
});
