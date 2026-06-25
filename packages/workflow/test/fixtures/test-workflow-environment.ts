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

/**
 * Creates a time-skipping {@link TestWorkflowEnvironment} with a pinned test
 * server version. Use this instead of calling `createTimeSkipping()` directly
 * so the download stays reproducible across the workflow test suites.
 */
export function createTimeSkippingTestEnvironment(): Promise<TestWorkflowEnvironment> {
    return TestWorkflowEnvironment.createTimeSkipping({
        server: {
            executable: {
                type: "cached-download",
                version: TIME_SKIPPING_TEST_SERVER_VERSION,
            },
        },
    });
}
