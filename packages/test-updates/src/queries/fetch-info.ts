import type { PrismaClient } from "@autonoma/db";

export async function fetchTestSuiteInfo(db: PrismaClient, snapshotId: string) {
    const testCaseAssignments = await db.testCaseAssignment.findMany({
        where: { snapshotId },
        select: {
            testCase: {
                select: {
                    id: true,
                    slug: true,
                    name: true,
                    folderId: true,
                    folder: { select: { name: true } },
                },
            },
            plan: {
                select: {
                    id: true,
                    prompt: true,
                    scenarioId: true,
                    scenario: { select: { id: true, name: true } },
                },
            },
            steps: { select: { id: true, list: true } },
            quarantineIssueId: true,
            quarantineIssue: { select: { kind: true, bugId: true } },
        },
    });

    return {
        testCases: testCaseAssignments.map(({ testCase, plan, steps, quarantineIssueId, quarantineIssue }) => ({
            id: testCase.id,
            slug: testCase.slug,
            name: testCase.name,
            folderId: testCase.folderId,
            plan,
            steps,
            quarantine:
                quarantineIssue != null
                    ? {
                          reason: quarantineIssue.kind,
                          bugId: quarantineIssue.bugId ?? undefined,
                          issueId: quarantineIssueId ?? undefined,
                      }
                    : undefined,
        })),
    };
}
