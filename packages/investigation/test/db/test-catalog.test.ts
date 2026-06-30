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

        test("listSnapshotTestCases returns only this snapshot's assigned tests, excluding other branches", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const a = await harness.setupTestCase(organizationId, application.id, "snap-a-test");
            const b = await harness.setupTestCase(organizationId, application.id, "snap-b-test");
            const catalog = new TestCatalog(harness.db);
            const slugs = async (snapshotId: string, createdBefore?: Date) =>
                (await catalog.listSnapshotTestCases(snapshotId, createdBefore)).map((testCase) => testCase.slug);

            // Scoped to THIS snapshot's assignments (the branch's own suite), not the other branch's snapshot.
            expect(await slugs(a.snapshotId)).toContain("snap-a-test");
            expect(await slugs(a.snapshotId)).not.toContain("snap-b-test");
            expect(await slugs(b.snapshotId)).toContain("snap-b-test");

            // createdBefore drops tests created after the cutoff (the deployed agent's same-PR additions).
            expect(await slugs(a.snapshotId, new Date(Date.now() + 60_000))).toContain("snap-a-test");
            expect(await slugs(a.snapshotId, new Date(Date.now() - 60_000))).not.toContain("snap-a-test");
        });

        test("returns undefined for unknown app or test", async ({ harness, seedResult: { application } }) => {
            const catalog = new TestCatalog(harness.db);
            expect(await catalog.resolveApplicationId("does-not-exist")).toBeUndefined();
            expect(await catalog.getLatestPlan(application.id, "does-not-exist")).toBeUndefined();
        });
    },
});
