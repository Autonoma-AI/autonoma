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

        const testCase = await harness.db.testCase.create({
            data: {
                name: "Homepage title test",
                slug: "homepage-title-test",
                applicationId: application.id,
                organizationId: harness.organizationId,
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

        const testCase2 = await harness.db.testCase.create({
            data: {
                name: "Empty test",
                slug: "empty-test",
                applicationId: application.id,
                organizationId: harness.organizationId,
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

        test("returns generation detail with steps", async ({ harness, seedResult: { generationWithSteps } }) => {
            const detail = await harness.request().generations.detail({
                generationId: generationWithSteps.id,
            });

            expect(detail).not.toBeNull();
            expect(detail?.id).toBe(generationWithSteps.id);
            expect(detail?.shortId).toBe(generationWithSteps.id.slice(0, 8));
            expect(detail?.steps).toHaveLength(2);
            expect(detail?.steps[0]?.order).toBe(0);
            expect(detail?.steps[0]?.interaction).toBe("navigate");
            expect(detail?.steps[1]?.order).toBe(1);
            expect(detail?.steps[1]?.interaction).toBe("assert");
            expect(detail?.createdAt).toBeInstanceOf(Date);
        });

        test("returns generation detail with empty steps when no outputs exist", async ({
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
