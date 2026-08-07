import { logger as rootLogger } from "@autonoma/logger";
import type { Suite } from "@autonoma/test-suite";
import type { ExistingTestInfo } from "../diffs-agent";

/**
 * Adapts the DB-shaped {@link Suite} into the {@link ExistingTestInfo}
 * array the diffs agent consumes. Test cases without an attached plan are
 * dropped with a warning log.
 */
export function mapTestSuiteToContext(suiteInfo: Suite): {
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
            description: testCase.description,
            prompt: testCase.plan.prompt,
        });
    }

    return { existingTests };
}
