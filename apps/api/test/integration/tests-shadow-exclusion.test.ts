import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

/**
 * A shadow test case (an investigation validation probe) must never appear in the customer's catalog. This guards
 * the exclusion added alongside the `TestCase.shadow` marker: `getTestCases` powers the tests tree, so a leak here
 * would surface the throwaway probe as a real test.
 */
async function seedRealAndShadowCases(harness: APITestHarness): Promise<{ applicationId: string }> {
    const application = await harness.services.applications.createApplication({
        name: `App ${crypto.randomUUID()}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });
    const folder = await harness.db.folder.create({
        data: { name: "default", applicationId: application.id, organizationId: harness.organizationId },
        select: { id: true },
    });
    await harness.db.testCase.create({
        data: {
            name: "Real test",
            slug: "real-test",
            applicationId: application.id,
            organizationId: harness.organizationId,
            folderId: folder.id,
        },
    });
    await harness.db.testCase.create({
        data: {
            name: "Investigation validation probe",
            slug: "__investigation_shadow__",
            shadow: true,
            applicationId: application.id,
            organizationId: harness.organizationId,
            folderId: folder.id,
        },
    });
    return { applicationId: application.id };
}

apiTestSuite({
    name: "testsService.getTestCases shadow exclusion",
    seed: async ({ harness }) => seedRealAndShadowCases(harness),
    cases: (test) => {
        test("returns the real case but not the shadow validation probe", async ({
            harness,
            seedResult: { applicationId },
        }) => {
            const cases = await harness.services.tests.getTestCases(applicationId, harness.organizationId);
            const slugs = cases.map((testCase) => testCase.slug);

            expect(slugs).toContain("real-test");
            expect(slugs).not.toContain("__investigation_shadow__");
        });
    },
});
