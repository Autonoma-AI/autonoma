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
        },
    });

    return {
        testCases: testCaseAssignments.map(({ testCase, plan }) => ({
            id: testCase.id,
            slug: testCase.slug,
            name: testCase.name,
            folderId: testCase.folderId,
            plan,
        })),
    };
}
