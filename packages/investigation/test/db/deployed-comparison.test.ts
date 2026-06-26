import { expect } from "vitest";
import { DeployedComparison } from "../../src/db/deployed-comparison";
import { investigationDbSuite } from "../harness";

investigationDbSuite({
    name: "deployed-comparison",
    cases: (test) => {
        test("by head SHA: returns the diffs job summary + per-test outcomes", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const testSlug = "audit-panel";
            const { snapshotId, testCaseId, assignmentId } = await harness.setupTestCase(
                organizationId,
                application.id,
                testSlug,
            );
            await harness.setSnapshotHeadSha(snapshotId, "deadbeef1234");
            const runId = await harness.createRun(
                organizationId,
                assignmentId,
                "failed",
                new Date("2026-06-10T00:00:00Z"),
            );
            await harness.createDiffsJob(snapshotId, organizationId, {
                status: "completed",
                analysisReasoning: "touches the audit panel",
                resolutionReasoning: "updated the assertion",
                analysisConversationUrl: "s3://bucket/analysis.json",
            });
            await harness.createAffectedTest(snapshotId, testCaseId, organizationId, {
                affectedReason: "code_change",
                reasoning: "exercises the panel",
                runId,
            });

            const comparison = await new DeployedComparison(harness.db).byHeadSha("deadbeef1234");

            expect(comparison.found).toBe(true);
            expect(comparison.jobStatus).toBe("completed");
            expect(comparison.analysisReasoning).toBe("touches the audit panel");
            expect(comparison.resolutionReasoning).toBe("updated the assertion");
            expect(comparison.analysisConversationUrl).toBe("s3://bucket/analysis.json");
            expect(comparison.perTest).toHaveLength(1);
            expect(comparison.perTest[0]?.testSlug).toBe(testSlug);
            expect(comparison.perTest[0]?.affectedReason).toBe("code_change");
            expect(comparison.perTest[0]?.runStatus).toBe("failed");
            expect(comparison.perTest[0]?.generatedFix).toBe(false);
        });

        test("by PR: resolves the latest snapshot the deployed agent ran a job on", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const testSlug = "favorites";
            const { branchId, snapshotId, testCaseId } = await harness.setupTestCase(
                organizationId,
                application.id,
                testSlug,
            );
            await harness.linkPullRequestToBranch(application.id, branchId, 4242);
            await harness.createDiffsJob(snapshotId, organizationId, { status: "completed", analysisReasoning: "x" });
            await harness.createAffectedTest(snapshotId, testCaseId, organizationId, { reasoning: "y" });

            const comparison = await new DeployedComparison(harness.db).byPr(application.slug, 4242);

            expect(comparison.found).toBe(true);
            expect(comparison.perTest[0]?.testSlug).toBe(testSlug);
        });

        test("returns not-found when no diffs job exists at that head SHA", async ({ harness }) => {
            const comparison = await new DeployedComparison(harness.db).byHeadSha("no-such-sha");
            expect(comparison.found).toBe(false);
            expect(comparison.perTest).toEqual([]);
        });
    },
});
