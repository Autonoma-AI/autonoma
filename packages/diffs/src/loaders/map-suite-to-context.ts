import { logger as rootLogger } from "@autonoma/logger";
import type { TestSuiteInfo } from "@autonoma/test-updates";
import type { ExistingTestInfo } from "../diffs-agent";

/**
 * Adapts the DB-shaped {@link TestSuiteInfo} into the {@link ExistingTestInfo}
 * array the diffs agent consumes. Test cases without an attached plan are
 * dropped with a warning log.
 */
export function mapTestSuiteToContext(suiteInfo: TestSuiteInfo): {
    existingTests: ExistingTestInfo[];
} {
    const logger = rootLogger.child({ name: "mapTestSuiteToContext" });

    const existingTests: ExistingTestInfo[] = [];
    for (const testCase of suiteInfo.testCases) {
        if (testCase.plan == null) {
            logger.warn("Test case has no plan, skipping", { testCaseId: testCase.id, slug: testCase.slug });
            continue;
        }
        existingTests.push({
            id: testCase.id,
            name: testCase.name,
            slug: testCase.slug,
            prompt: testCase.plan.prompt,
            quarantine: testCase.quarantine,
        });
    }

    return { existingTests };
}
