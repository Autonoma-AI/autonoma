import { expect } from "vitest";
import { testSuiteSuite } from "./harness";

testSuiteSuite({
    name: "TestSuiteStore.readAssignments",
    cases: (test) => {
        test("returns every snapshot's assignments in one flat read, tagged by snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const login = await harness.createTestWithPlan(organizationId, applicationId, folderId, { slug: "login" });
            const signup = await harness.createTestWithPlan(organizationId, applicationId, folderId, {
                slug: "signup",
            });

            const earlier = await harness.createActiveSnapshot(branchId, {
                assignments: [{ testCaseId: login.testCaseId, planId: login.planId }],
            });
            const later = await harness.createActiveSnapshot(branchId, {
                assignments: [
                    { testCaseId: login.testCaseId, planId: login.planId },
                    { testCaseId: signup.testCaseId, planId: signup.planId },
                ],
            });

            const assignments = await harness.store.readAssignments([earlier, later]);

            expect(assignments).toHaveLength(3);
            expect(assignments.filter((a) => a.snapshotId === earlier).map((a) => a.slug)).toEqual(["login"]);
            expect(
                assignments
                    .filter((a) => a.snapshotId === later)
                    .map((a) => a.slug)
                    .sort(),
            ).toEqual(["login", "signup"]);
            expect(assignments.find((a) => a.snapshotId === earlier)).toMatchObject({
                testCaseId: login.testCaseId,
                planId: login.planId,
                slug: "login",
            });
        });

        test("reports an assignment that pins no plan rather than omitting it", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const { testCaseId } = await harness.createTestWithPlan(organizationId, applicationId, folderId, {
                slug: "planless",
            });
            const snapshotId = await harness.createActiveSnapshot(branchId, { assignments: [{ testCaseId }] });

            const assignments = await harness.store.readAssignments([snapshotId]);

            expect(assignments).toHaveLength(1);
            expect(assignments[0]).toMatchObject({ slug: "planless", planId: null });
        });

        test("asks nothing of the database when there are no snapshots to read", async ({ harness }) => {
            expect(await harness.store.readAssignments([])).toEqual([]);
        });
    },
});
