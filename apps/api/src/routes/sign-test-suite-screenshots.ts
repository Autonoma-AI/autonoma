import type { StorageProvider } from "@autonoma/storage";
import type { TestSuiteInfo } from "@autonoma/test-updates";

const SIGNED_URL_TTL_SECONDS = 3600;

type Steps = TestSuiteInfo["testCases"][number]["steps"];

/**
 * Signs the S3 screenshot keys stored on each step so the frontend receives
 * browser-openable HTTPS URLs instead of raw `s3://...` keys. The shared
 * `fetchTestSuiteInfo` query intentionally returns raw keys (workers consume
 * them directly), so signing happens here at the API boundary.
 */
export async function signTestSuiteScreenshots(
    testSuite: TestSuiteInfo,
    storageProvider: StorageProvider,
): Promise<TestSuiteInfo> {
    const testCases = await Promise.all(
        testSuite.testCases.map(async (testCase) => ({
            ...testCase,
            steps: await signStepScreenshots(testCase.steps, storageProvider),
        })),
    );

    return { testCases };
}

async function signStepScreenshots(steps: Steps, storageProvider: StorageProvider): Promise<Steps> {
    if (steps == null) return steps;

    const list = await Promise.all(
        steps.list.map(async (step) => ({
            ...step,
            screenshotBefore:
                step.screenshotBefore != null
                    ? await storageProvider.getSignedUrl(step.screenshotBefore, SIGNED_URL_TTL_SECONDS)
                    : step.screenshotBefore,
            screenshotAfter:
                step.screenshotAfter != null
                    ? await storageProvider.getSignedUrl(step.screenshotAfter, SIGNED_URL_TTL_SECONDS)
                    : step.screenshotAfter,
        })),
    );

    return { ...steps, list };
}
