import { logger as rootLogger } from "@autonoma/logger";
import { TestWorkflowEnvironment } from "@temporalio/testing";

/**
 * Time-skipping test server version to download.
 *
 * The SDK normally resolves the binary via the "default"/"latest" alias on
 * temporal.download, but those aliases currently 404 for the test server (only
 * explicit version tags resolve). Pin an explicit version so CI can fetch the
 * binary deterministically. Bump this when upgrading the Temporal SDK.
 */
const TIME_SKIPPING_TEST_SERVER_VERSION = "v1.30.1";

/** First use on a machine downloads the test server binary, so allow one retry for a flaky network. */
const CREATE_ATTEMPTS = 2;

/**
 * Creates a time-skipping {@link TestWorkflowEnvironment} with a pinned test
 * server version. Use this instead of calling `createTimeSkipping()` directly
 * so the download stays reproducible across the workflow test suites.
 */
export async function createTimeSkippingTestEnvironment(): Promise<TestWorkflowEnvironment> {
    const logger = rootLogger.child({ name: "createTimeSkippingTestEnvironment" });
    let lastError: unknown;

    for (let attempt = 1; attempt <= CREATE_ATTEMPTS; attempt += 1) {
        try {
            const env = await TestWorkflowEnvironment.createTimeSkipping({
                server: {
                    executable: {
                        type: "cached-download",
                        version: TIME_SKIPPING_TEST_SERVER_VERSION,
                    },
                },
            });
            logger.info("Time-skipping test environment ready", { extra: { attempt } });
            return env;
        } catch (err) {
            lastError = err;
            if (attempt === CREATE_ATTEMPTS) throw err;
            logger.warn("Failed to start the time-skipping test environment, retrying", { extra: { attempt, err } });
        }
    }

    throw lastError;
}
