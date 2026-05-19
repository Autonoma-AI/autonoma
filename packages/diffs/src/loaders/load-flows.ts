import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { TestSuiteInfo } from "@autonoma/test-updates";
import type { FlowInfo } from "../flow-index";

/**
 * Loads the application's folders and groups the snapshot's test slugs by
 * folder, producing {@link FlowInfo} entries the diffs agent indexes.
 */
export async function loadFlows(
    db: PrismaClient,
    applicationId: string,
    suiteInfo: TestSuiteInfo,
): Promise<FlowInfo[]> {
    const logger = rootLogger.child({ name: "loadFlows", applicationId });

    const folders = await db.folder.findMany({
        where: { applicationId },
        select: { id: true, name: true, description: true },
    });

    const testSlugsByFolderId = new Map<string, string[]>();
    for (const testCase of suiteInfo.testCases) {
        if (testCase.plan == null) {
            logger.warn("Test case has no plan, skipping from flow index", {
                testCaseId: testCase.id,
                slug: testCase.slug,
            });
            continue;
        }
        const slugs = testSlugsByFolderId.get(testCase.folderId);
        if (slugs != null) {
            slugs.push(testCase.slug);
        } else {
            testSlugsByFolderId.set(testCase.folderId, [testCase.slug]);
        }
    }

    return folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        description: folder.description ?? undefined,
        testSlugs: testSlugsByFolderId.get(folder.id) ?? [],
    }));
}
