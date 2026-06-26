import { expect } from "vitest";
import { PriorRuns } from "../../src/db/prior-runs";
import { investigationDbSuite } from "../harness";

investigationDbSuite({
    name: "getPriorRunsHistory",
    cases: (test) => {
        test("summarizes a test's pass/fail history, newest-first, with the most recent success", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const testSlug = "transaction-list-view";
            const { assignmentId } = await harness.setupTestCase(organizationId, application.id, testSlug);
            await harness.createRun(organizationId, assignmentId, "failed", new Date("2026-06-01T00:00:00Z"), {
                kind: "scenario_setup",
                message: "scenario up failed",
            });
            await harness.createRun(organizationId, assignmentId, "success", new Date("2026-06-05T00:00:00Z"));
            await harness.createRun(organizationId, assignmentId, "failed", new Date("2026-06-10T00:00:00Z"));

            const history = await new PriorRuns(harness.db).getHistory(application.slug, testSlug);

            expect(history.totalRecent).toBe(3);
            expect(history.everPassed).toBe(true);
            expect(history.successCount).toBe(1);
            expect(history.mostRecentSuccessDay).toBe("2026-06-05");
            expect(history.recent[0]?.day).toBe("2026-06-10");
            expect(history.recent[0]?.status).toBe("failed");
            const oldestFailure = history.recent.find((run) => run.day === "2026-06-01");
            expect(oldestFailure?.failureKind).toBe("scenario_setup");
        });

        test("a never-passed test reports everPassed=false and no most-recent-success", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const testSlug = "never-passed-test";
            const { assignmentId } = await harness.setupTestCase(organizationId, application.id, testSlug);
            await harness.createRun(organizationId, assignmentId, "failed", new Date("2026-06-02T00:00:00Z"));

            const history = await new PriorRuns(harness.db).getHistory(application.slug, testSlug);

            expect(history.everPassed).toBe(false);
            expect(history.successCount).toBe(0);
            expect(history.mostRecentSuccessDay).toBeUndefined();
        });

        test("an unknown test returns empty history", async ({ harness, seedResult: { application } }) => {
            const history = await new PriorRuns(harness.db).getHistory(application.slug, "does-not-exist");
            expect(history.totalRecent).toBe(0);
            expect(history.everPassed).toBe(false);
            expect(history.recent).toEqual([]);
        });
    },
});
