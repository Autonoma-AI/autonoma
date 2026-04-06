import { randomUUID } from "node:crypto";
import { ApplicationArchitecture } from "@autonoma/db";
import { TRPCError } from "@trpc/server";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

apiTestSuite({
    name: "branches",
    seed: async () => ({}),
    cases: (test) => {
        test("lists and loads the main branch by name", async ({ harness }) => {
            const suffix = randomUUID();
            const application = await harness.services.applications.createApplication({
                name: `Branches App ${suffix}`,
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/default-file.png",
            });

            const branches = await harness.request().branches.list({ applicationId: application.id });
            expect(branches).toHaveLength(1);
            expect(branches[0]?.name).toBe("main");

            const branch = await harness.request().branches.detailByName({
                applicationId: application.id,
                branchName: "main",
            });

            expect(branch.name).toBe("main");
            expect(branch.activeSnapshot.testCaseAssignments).toEqual([]);
        });

        test("creates a branch by cloning main snapshot assignments", async ({ harness }) => {
            const suffix = randomUUID();
            const application = await harness.services.applications.createApplication({
                name: `Branch Clone App ${suffix}`,
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/default-file.png",
            });

            const mainBranch = await harness.db.branch.findFirstOrThrow({
                where: { applicationId: application.id, name: "main" },
                select: { id: true, activeSnapshotId: true },
            });

            const activeSnapshotId = mainBranch.activeSnapshotId;
            if (activeSnapshotId == null) {
                throw new Error("Main branch is missing an active snapshot");
            }

            const testCase = await harness.db.testCase.create({
                data: {
                    name: `Login ${suffix}`,
                    slug: `login-${suffix}`,
                    applicationId: application.id,
                    organizationId: harness.organizationId,
                },
            });

            const plan = await harness.db.testPlan.create({
                data: {
                    prompt: "Open login and verify sign-in",
                    testCaseId: testCase.id,
                    organizationId: harness.organizationId,
                },
            });

            const steps = await harness.db.stepInputList.create({
                data: { planId: plan.id, organizationId: harness.organizationId },
            });

            await harness.db.testCaseAssignment.create({
                data: {
                    snapshotId: activeSnapshotId,
                    testCaseId: testCase.id,
                    planId: plan.id,
                    stepsId: steps.id,
                },
            });

            const createdSkill = await harness.services.skills.createSkill({
                name: `Auth Skill ${suffix}`,
                description: "Login helpers",
                content: "Use the sign-in flow when authentication is required.",
                applicationId: application.id,
                organizationId: harness.organizationId,
            });

            const createdBranch = await harness.request().branches.create({
                applicationId: application.id,
                name: `feature-${suffix}`,
                githubRef: "refs/heads/feature",
            });

            const clonedBranch = await harness.db.branch.findUniqueOrThrow({
                where: { id: createdBranch.id },
                include: {
                    activeSnapshot: {
                        include: {
                            testCaseAssignments: true,
                            skillAssignments: true,
                        },
                    },
                },
            });

            expect(clonedBranch.githubRef).toBe("refs/heads/feature");
            expect(clonedBranch.activeSnapshot?.testCaseAssignments).toHaveLength(1);
            expect(clonedBranch.activeSnapshot?.skillAssignments).toHaveLength(1);

            const clonedTestAssignment = clonedBranch.activeSnapshot?.testCaseAssignments[0];
            expect(clonedTestAssignment?.testCaseId).toBe(testCase.id);
            expect(clonedTestAssignment?.mainAssignmentId).toBeDefined();

            const clonedSkillAssignment = clonedBranch.activeSnapshot?.skillAssignments[0];
            expect(clonedSkillAssignment?.skillId).toBe(createdSkill.id);
            expect(clonedSkillAssignment?.mainAssignmentId).toBeDefined();
        });

        test("deletes non-main branches and rejects deleting the main branch", async ({ harness }) => {
            const suffix = randomUUID();
            const application = await harness.services.applications.createApplication({
                name: `Delete Branch App ${suffix}`,
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/default-file.png",
            });

            const mainBranch = await harness.db.branch.findFirstOrThrow({
                where: { applicationId: application.id, name: "main" },
                select: { id: true },
            });

            const createdBranch = await harness.request().branches.create({
                applicationId: application.id,
                name: `cleanup-${suffix}`,
            });

            await harness.request().branches.delete({ branchId: createdBranch.id });

            const deletedBranch = await harness.db.branch.findUnique({ where: { id: createdBranch.id } });
            expect(deletedBranch).toBeNull();

            await expect(harness.request().branches.delete({ branchId: mainBranch.id })).rejects.toBeInstanceOf(
                TRPCError,
            );
        });
    },
});
