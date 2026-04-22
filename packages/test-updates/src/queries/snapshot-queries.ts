import type { PrismaClient } from "@autonoma/db";

export async function fetchTestSuiteInfo(db: PrismaClient, snapshotId: string) {
    return db.$transaction(async (tx) => {
        const testCaseAssignments = await tx.testCaseAssignment.findMany({
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
            },
        });

        const skillAssignments = await tx.skillAssignment.findMany({
            where: { snapshotId },
            select: {
                skillId: true,
                skill: { select: { id: true, slug: true, name: true, description: true } },
                planId: true,
                plan: { select: { content: true } },
            },
        });

        return {
            testCases: testCaseAssignments.map(({ testCase, plan, steps }) => ({
                id: testCase.id,
                slug: testCase.slug,
                name: testCase.name,
                folderId: testCase.folderId,
                plan,
                steps,
            })),
            skills: skillAssignments.map(({ skill, plan }) => ({
                id: skill.id,
                slug: skill.slug,
                name: skill.name,
                description: skill.description,
                plan,
            })),
        };
    });
}
