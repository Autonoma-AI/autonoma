import type { Prisma, PrismaClient } from "@autonoma/db";

/** One version of a branch's test suite: the tests a snapshot assigns, each with its pinned plan. */
export interface Suite {
    testCases: SuiteTestCase[];
}

export interface SuiteTestCase {
    id: string;
    slug: string;
    name: string;
    description?: string;
    folderId: string;
    /** The plan the assignment pins; null for an assignment with no plan. */
    plan: SuiteTestPlan | null;
}

export interface SuiteTestPlan {
    id: string;
    prompt: string;
    scenarioId: string | null;
}

/** Read one snapshot's suite. Pure read: valid for open and terminal snapshots alike. */
export async function readSuite(db: PrismaClient | Prisma.TransactionClient, snapshotId: string): Promise<Suite> {
    const assignments = await db.testCaseAssignment.findMany({
        where: { snapshotId },
        select: {
            testCase: {
                select: {
                    id: true,
                    slug: true,
                    name: true,
                    description: true,
                    folderId: true,
                },
            },
            plan: { select: { id: true, prompt: true, scenarioId: true } },
        },
    });

    return {
        testCases: assignments.map(({ testCase, plan }) => ({
            id: testCase.id,
            slug: testCase.slug,
            name: testCase.name,
            description: testCase.description ?? undefined,
            folderId: testCase.folderId,
            plan,
        })),
    };
}
