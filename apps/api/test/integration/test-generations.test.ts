import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

apiTestSuite({
    name: "generations",
    seed: async ({ harness }) => {
        const application = await harness.services.applications.createApplication({
            name: "My Web App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/default-file.png",
        });

        const mainBranch = await harness.db.branch.findFirstOrThrow({
            where: { applicationId: application.id },
            select: { activeSnapshotId: true },
        });

        // biome-ignore lint/style/noNonNullAssertion: `applications.createApplication` adds an active snapshot
        const snapshotId = mainBranch.activeSnapshotId!;

        const folder = await harness.db.folder.create({
            data: {
                name: "Default",
                applicationId: application.id,
                organizationId: harness.organizationId,
            },
        });

        const testCase = await harness.db.testCase.create({
            data: {
                name: "Homepage title test",
                slug: "homepage-title-test",
                applicationId: application.id,
                organizationId: harness.organizationId,
                folderId: folder.id,
            },
        });

        const testPlan = await harness.db.testPlan.create({
            data: {
                prompt: "Navigate to the homepage and verify the title is visible",
                testCaseId: testCase.id,
                organizationId: harness.organizationId,
            },
        });

        const stepInputList = await harness.db.stepInputList.create({
            data: { planId: testPlan.id, organizationId: harness.organizationId },
        });

        const stepOutputList = await harness.db.stepOutputList.create({
            data: { organizationId: harness.organizationId },
        });

        const si0 = await harness.db.stepInput.create({
            data: {
                listId: stepInputList.id,
                order: 0,
                interaction: "navigate",
                params: {},
                organizationId: harness.organizationId,
            },
        });

        const si1 = await harness.db.stepInput.create({
            data: {
                listId: stepInputList.id,
                order: 1,
                interaction: "assert",
                params: {},
                organizationId: harness.organizationId,
            },
        });

        await harness.db.stepOutput.create({
            data: {
                listId: stepOutputList.id,
                order: 0,
                output: {},
                stepInputId: si0.id,
                organizationId: harness.organizationId,
            },
        });

        await harness.db.stepOutput.create({
            data: {
                listId: stepOutputList.id,
                order: 1,
                output: {},
                stepInputId: si1.id,
                organizationId: harness.organizationId,
            },
        });

        const generationWithSteps = await harness.db.testGeneration.create({
            data: {
                testPlanId: testPlan.id,
                snapshotId,
                organizationId: harness.organizationId,
                stepsId: stepInputList.id,
                outputsId: stepOutputList.id,
            },
        });

        // The full attempt timeline counts failures: a successful navigate, a
        // failed assert (e.g. an assertion that did not hold), then a successful
        // assert. The successful-only replay list (StepInput/StepOutput above)
        // legitimately diverges from this timeline.
        await harness.db.stepAttempt.createMany({
            data: [
                {
                    generationId: generationWithSteps.id,
                    organizationId: harness.organizationId,
                    order: 0,
                    interaction: "navigate",
                    params: {},
                    status: "success",
                    output: {},
                },
                {
                    generationId: generationWithSteps.id,
                    organizationId: harness.organizationId,
                    order: 1,
                    interaction: "assert",
                    params: {},
                    status: "failed",
                    error: "Expected the title to be visible, but it was not",
                    errorName: "VerificationError",
                },
                {
                    generationId: generationWithSteps.id,
                    organizationId: harness.organizationId,
                    order: 2,
                    interaction: "assert",
                    params: {},
                    status: "success",
                    output: {},
                },
            ],
        });

        const testCase2 = await harness.db.testCase.create({
            data: {
                name: "Empty test",
                slug: "empty-test",
                applicationId: application.id,
                organizationId: harness.organizationId,
                folderId: folder.id,
            },
        });

        const testPlan2 = await harness.db.testPlan.create({
            data: {
                prompt: "Another plan",
                testCaseId: testCase2.id,
                organizationId: harness.organizationId,
            },
        });

        const generationWithoutSteps = await harness.db.testGeneration.create({
            data: {
                testPlanId: testPlan2.id,
                snapshotId,
                organizationId: harness.organizationId,
            },
        });

        return { application, testCase, testPlan, generationWithSteps, generationWithoutSteps };
    },
    cases: (test) => {
        test("lists all generations for the organization", async ({
            harness,
            seedResult: { generationWithSteps, generationWithoutSteps },
        }) => {
            const list = await harness.request().generations.list();

            expect(list).toHaveLength(2);
            const ids = list.map((g) => g.id);
            expect(ids).toContain(generationWithSteps.id);
            expect(ids).toContain(generationWithoutSteps.id);
        });

        test("list returns generations ordered by createdAt descending", async ({
            harness,
            seedResult: { generationWithSteps, generationWithoutSteps },
        }) => {
            const list = await harness.request().generations.list();

            expect(list[0]?.id).toBe(generationWithoutSteps.id);
            expect(list[1]?.id).toBe(generationWithSteps.id);
        });

        test("list returns correct shape for a generation with steps", async ({
            harness,
            seedResult: { generationWithSteps },
        }) => {
            const list = await harness.request().generations.list();
            const item = list.find((g) => g.id === generationWithSteps.id);

            expect(item).toBeDefined();
            expect(item?.shortId).toBe(generationWithSteps.id.slice(0, 8));
            expect(item?.testName).toBe("Homepage title test");
            expect(item?.stepCount).toBe(2);
            expect(item?.tags).toEqual([]);
            expect(item?.createdAt).toBeInstanceOf(Date);
        });

        test("list returns zero stepCount for a generation without steps", async ({
            harness,
            seedResult: { generationWithoutSteps },
        }) => {
            const list = await harness.request().generations.list();
            const item = list.find((g) => g.id === generationWithoutSteps.id);

            expect(item?.testName).toBe("Empty test");
            expect(item?.stepCount).toBe(0);
            expect(item?.tags).toEqual([]);
        });

        test("returns generation detail with the full attempt timeline", async ({
            harness,
            seedResult: { generationWithSteps },
        }) => {
            const detail = await harness.request().generations.detail({
                generationId: generationWithSteps.id,
            });

            expect(detail).not.toBeNull();
            expect(detail?.id).toBe(generationWithSteps.id);
            expect(detail?.shortId).toBe(generationWithSteps.id.slice(0, 8));
            // The timeline includes the failed attempt, unlike the successful-only replay list.
            expect(detail?.steps).toHaveLength(3);
            expect(detail?.steps[0]?.order).toBe(0);
            expect(detail?.steps[0]?.interaction).toBe("navigate");
            expect(detail?.steps[0]?.status).toBe("success");
            expect(detail?.steps[1]?.order).toBe(1);
            expect(detail?.steps[1]?.interaction).toBe("assert");
            expect(detail?.steps[2]?.order).toBe(2);
            expect(detail?.steps[2]?.interaction).toBe("assert");
            expect(detail?.createdAt).toBeInstanceOf(Date);
            // The seed snapshot belongs to the main branch, which has no PR.
            expect(detail?.pullRequest).toBeUndefined();
        });

        test("detail surfaces failed attempts with their error and error name", async ({
            harness,
            seedResult: { generationWithSteps },
        }) => {
            const detail = await harness.request().generations.detail({
                generationId: generationWithSteps.id,
            });

            const failed = detail?.steps[1];
            expect(failed?.status).toBe("failed");
            expect(failed?.error).toBe("Expected the title to be visible, but it was not");
            expect(failed?.errorName).toBe("VerificationError");
            expect(failed?.output).toBeUndefined();
        });

        test("detail exposes the pull request and snapshot when the generation's snapshot belongs to a PR", async ({
            harness,
            seedResult: { application, testPlan },
        }) => {
            const branch = await harness.db.branch.create({
                data: {
                    name: "feature/checkout",
                    applicationId: application.id,
                    organizationId: harness.organizationId,
                },
            });
            const snapshot = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: "deadbeef99999" },
            });
            await harness.db.featureBranchInfo.create({
                data: { branchId: branch.id, applicationId: application.id, prNumber: 99 },
            });
            const generation = await harness.db.testGeneration.create({
                data: {
                    testPlanId: testPlan.id,
                    snapshotId: snapshot.id,
                    organizationId: harness.organizationId,
                },
            });

            const detail = await harness.request().generations.detail({ generationId: generation.id });

            expect(detail?.pullRequest).toEqual({
                number: 99,
                snapshotId: snapshot.id,
                snapshotSha: "deadbeef99999",
            });
        });

        test("returns generation detail with empty steps when no attempts exist", async ({
            harness,
            seedResult: { generationWithoutSteps },
        }) => {
            const detail = await harness.request().generations.detail({
                generationId: generationWithoutSteps.id,
            });

            expect(detail).not.toBeNull();
            expect(detail?.steps).toEqual([]);
        });

        test("throws error for a non-existent generationId", async ({ harness }) => {
            await expect(
                harness.request().generations.detail({
                    generationId: "non-existent-id",
                }),
            ).rejects.toThrowError();
        });

        test("throws when generationId belongs to a different organization", async ({
            harness,
            seedResult: { generationWithSteps },
        }) => {
            const otherOrg = await harness.db.organization.create({
                data: { name: "Other Org", slug: `other-org-${crypto.randomUUID()}` },
            });
            const otherSession = await harness.db.session.create({
                data: {
                    token: `other-session-${crypto.randomUUID()}`,
                    expiresAt: new Date(Date.now() + 86400000),
                    userId: harness.userId,
                    activeOrganizationId: otherOrg.id,
                },
            });

            await expect(
                harness.request(otherSession).generations.detail({
                    generationId: generationWithSteps.id,
                }),
            ).rejects.toThrowError();
        });
    },
});
