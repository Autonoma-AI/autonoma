import { expect } from "vitest";
import { TestCatalog } from "../../src/db/test-catalog";
import { investigationDbSuite } from "../harness";

investigationDbSuite({
    name: "TestCatalog",
    cases: (test) => {
        test("lists a snapshot's assigned tests by flow and returns each pinned plan", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const testSlug = "list-view";
            const { snapshotId } = await harness.setupTestCase(organizationId, application.id, testSlug);
            const catalog = new TestCatalog(harness.db);

            expect(await catalog.resolveApplicationId(application.slug)).toBe(application.id);

            const cases = await catalog.listSnapshotTestCases(snapshotId);
            const listView = cases.find((testCase) => testCase.slug === testSlug);
            expect(listView).toBeDefined();
            expect(listView?.flow).toBe("default");

            expect(await catalog.getSnapshotPlan(snapshotId, testSlug)).toBe("initial plan");
        });

        test("runs the snapshot's PINNED plan, not the test case's latest plan", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const testSlug = "pinned";
            const { snapshotId, testCaseId, assignmentId } = await harness.setupTestCase(
                organizationId,
                application.id,
                testSlug,
            );
            const catalog = new TestCatalog(harness.db);

            const assignment = await harness.db.testCaseAssignment.findUniqueOrThrow({
                where: { id: assignmentId },
                select: { planId: true },
            });

            // The diffs agent authors a NEWER plan for the same test case (a same-PR plan edit). Selection must
            // still run the plan the snapshot pinned, never this newer one - that independence is the whole point.
            await harness.db.testPlan.create({
                data: { testCaseId, prompt: "diffs-agent edited plan", organizationId },
            });

            expect((await catalog.resolveSnapshotPlan(snapshotId, testSlug))?.planId).toBe(assignment.planId);
            expect(await catalog.getSnapshotPlan(snapshotId, testSlug)).toBe("initial plan");
        });

        test("scopes to THIS snapshot's assignments, not another branch's", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const a = await harness.setupTestCase(organizationId, application.id, "snap-a");
            const b = await harness.setupTestCase(organizationId, application.id, "snap-b");
            const catalog = new TestCatalog(harness.db);
            const slugs = async (snapshotId: string) =>
                (await catalog.listSnapshotTestCases(snapshotId)).map((testCase) => testCase.slug);

            expect(await slugs(a.snapshotId)).toContain("snap-a");
            expect(await slugs(a.snapshotId)).not.toContain("snap-b");
            expect(await slugs(b.snapshotId)).toContain("snap-b");
        });

        test("excludes assignments with no pinned plan and quarantined assignments (not runnable)", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const { snapshotId } = await harness.setupTestCase(organizationId, application.id, "runnable");
            const folder = await harness.db.folder.findFirstOrThrow({ where: { applicationId: application.id } });
            const catalog = new TestCatalog(harness.db);

            // A test assigned to the same snapshot but with no pinned plan - not a runnable test.
            const planless = await harness.db.testCase.create({
                data: {
                    name: "planless",
                    slug: "planless",
                    applicationId: application.id,
                    organizationId,
                    folderId: folder.id,
                },
            });
            await harness.db.testCaseAssignment.create({ data: { snapshotId, testCaseId: planless.id } });

            // A quarantined test (known-broken) - excluded even though it has a pinned plan.
            const quarantined = await harness.setupTestCase(organizationId, application.id, "quarantined");
            const issue = await harness.db.issue.create({
                data: { severity: "high", title: "broken", description: "quarantined for test", organizationId },
            });
            await harness.db.testCaseAssignment.update({
                where: { id: quarantined.assignmentId },
                data: { quarantineIssueId: issue.id },
            });

            const slugs = (await catalog.listSnapshotTestCases(snapshotId)).map((testCase) => testCase.slug);
            expect(slugs).toContain("runnable");
            expect(slugs).not.toContain("planless");
            expect(await catalog.resolveSnapshotPlan(snapshotId, "planless")).toBeUndefined();

            const quarantinedSlugs = (await catalog.listSnapshotTestCases(quarantined.snapshotId)).map(
                (testCase) => testCase.slug,
            );
            expect(quarantinedSlugs).not.toContain("quarantined");
            expect(await catalog.resolveSnapshotPlan(quarantined.snapshotId, "quarantined")).toBeUndefined();
        });

        test("returns undefined for unknown app or test", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const { snapshotId } = await harness.setupTestCase(organizationId, application.id, "known");
            const catalog = new TestCatalog(harness.db);
            expect(await catalog.resolveApplicationId("does-not-exist")).toBeUndefined();
            expect(await catalog.getSnapshotPlan(snapshotId, "does-not-exist")).toBeUndefined();
            expect(await catalog.resolveSnapshotPlan(snapshotId, "does-not-exist")).toBeUndefined();
        });
    },
});
