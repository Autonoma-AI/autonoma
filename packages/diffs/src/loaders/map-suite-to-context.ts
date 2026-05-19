import { logger as rootLogger } from "@autonoma/logger";
import type { TestSuiteInfo } from "@autonoma/test-updates";
import type { ExistingSkillInfo, ExistingTestInfo } from "../diffs-agent";

/**
 * Adapts the DB-shaped {@link TestSuiteInfo} into the {@link ExistingTestInfo} /
 * {@link ExistingSkillInfo} arrays the diffs agent consumes. Test cases and
 * skills without an attached plan are dropped with a warning log.
 */
export function mapTestSuiteToContext(suiteInfo: TestSuiteInfo): {
    existingTests: ExistingTestInfo[];
    existingSkills: ExistingSkillInfo[];
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

    const existingSkills: ExistingSkillInfo[] = [];
    for (const skill of suiteInfo.skills) {
        if (skill.plan == null) {
            logger.warn("Skill has no plan, skipping", { skillId: skill.id, slug: skill.slug });
            continue;
        }
        existingSkills.push({
            id: skill.id,
            name: skill.name,
            slug: skill.slug,
            description: skill.description,
            content: skill.plan.content,
        });
    }

    return { existingTests, existingSkills };
}
