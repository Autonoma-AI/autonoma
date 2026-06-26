import { expect } from "vitest";
import { TestCatalog } from "../../src/db/test-catalog";
import { investigationDbSuite } from "../harness";

investigationDbSuite({
    name: "TestCatalog",
    cases: (test) => {
        test("resolves app id, lists test cases by flow, and returns the latest plan", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const testSlug = "list-view";
            await harness.setupTestCase(organizationId, application.id, testSlug);
            const catalog = new TestCatalog(harness.db);

            expect(await catalog.resolveApplicationId(application.slug)).toBe(application.id);

            const cases = await catalog.listTestCases(application.id);
            const listView = cases.find((testCase) => testCase.slug === testSlug);
            expect(listView).toBeDefined();
            expect(listView?.flow).toBe("default");

            expect(await catalog.getLatestPlan(application.id, testSlug)).toBe("initial plan");
        });

        test("createdBefore excludes tests created at/after the cutoff (independent selection)", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const testSlug = "created-now";
            await harness.setupTestCase(organizationId, application.id, testSlug);
            const catalog = new TestCatalog(harness.db);
            const has = (cases: { slug: string }[]) => cases.some((testCase) => testCase.slug === testSlug);

            expect(has(await catalog.listTestCases(application.id, new Date(Date.now() + 60_000)))).toBe(true);
            expect(has(await catalog.listTestCases(application.id, new Date(Date.now() - 60_000)))).toBe(false);
        });

        test("returns undefined for unknown app or test", async ({ harness, seedResult: { application } }) => {
            const catalog = new TestCatalog(harness.db);
            expect(await catalog.resolveApplicationId("does-not-exist")).toBeUndefined();
            expect(await catalog.getLatestPlan(application.id, "does-not-exist")).toBeUndefined();
        });
    },
});
