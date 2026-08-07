import { ApplicationArchitecture } from "@autonoma/db";
import { countAnalysisFindingBuckets } from "@autonoma/types";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedAnalysisFindings } from "../seed-analysis-findings";

/**
 * The checkpoint-history rail (branches.snapshotHistory) must read an authoritative snapshot's badge from the
 * AnalysisReport verdict + finding categories, not the legacy health/Bug model the merged pipeline never
 * populates. A legacy diffs snapshot must be untouched.
 */

async function createBranch(harness: APITestHarness): Promise<{ branchId: string }> {
    const application = await harness.services.applications.createApplication({
        name: `App ${crypto.randomUUID()}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by createApplication
    return { branchId: application.mainBranchId! };
}

async function createSnapshot(harness: APITestHarness, branchId: string, headSha: string): Promise<string> {
    const snapshot = await harness.db.branchSnapshot.create({
        data: { branchId, source: "GITHUB_PUSH", status: "active", baseSha: "base", headSha },
    });
    return snapshot.id;
}

async function attachAnalysisReport(
    harness: APITestHarness,
    snapshotId: string,
    verdict: string,
    categories: string[],
): Promise<void> {
    await harness.db.analysisJob.create({
        data: { snapshotId, status: "completed", organizationId: harness.organizationId },
    });
    // The badge reads its counts straight off the report, as the real Reporter writes them: the coverage-plane
    // total and the test count, plus the issue-derived bug count (not the client_bug finding tally, so a bug
    // carried across snapshots keeps the PR red even when no test re-ran it).
    const buckets = countAnalysisFindingBuckets(categories);
    await harness.db.analysisReport.create({
        data: {
            snapshotId,
            verdict,
            clientBugCount: categories.filter((category) => category === "client_bug").length,
            testCount: categories.length,
            coverage: { total: buckets.coverage, byCategory: [] },
            summary: `Run verdict: ${verdict}.`,
            reportMarkdown: `## Run\n\nVerdict: ${verdict}.`,
            organizationId: harness.organizationId,
        },
    });
    // Findings key to the AnalysisJob; create them directly against the shared snapshot id. Each verdict FKs the
    // generation whose run produced it.
    await seedAnalysisFindings(
        harness.db,
        snapshotId,
        categories.map((category, index) => ({
            slug: `slug-${index}`,
            category,
            headline: `Finding ${index}`,
        })),
    );
}

apiTestSuite({
    name: "branches authoritative summary",
    cases: (test) => {
        test("a client-bug authoritative checkpoint reads 'N bugs' (red), never awaiting-triage", async ({
            harness,
        }) => {
            const { branchId } = await createBranch(harness);
            const snapshotId = await createSnapshot(harness, branchId, "head-bug");
            // One client bug, two passed, one coverage-plane finding.
            await attachAnalysisReport(harness, snapshotId, "client_bug", [
                "client_bug",
                "passed",
                "passed",
                "engine_artifact",
            ]);

            const history = await harness.request().branches.snapshotHistory({ branchId });
            const row = history.find((s) => s.id === snapshotId);

            expect(row?.summary?.tone).toBe("critical");
            expect(row?.summary?.label).toBe("1 bug");
            expect(row?.summary?.reason).toBeUndefined();
            expect(row?.summary?.analysis).toEqual({
                jobStatus: "completed",
                bugCount: 1,
                passedCount: 2,
                coverageCount: 1,
            });
            expect(row?.health).toBe("critical");
        });

        test("an authoritative checkpoint with a coverage gap reads 'Not confirmed' (amber), non-blocking", async ({
            harness,
        }) => {
            const { branchId } = await createBranch(harness);
            const snapshotId = await createSnapshot(harness, branchId, "head-pass");
            // No client bugs, but a coverage gap means the change was not fully confirmed: amber, not green, and not
            // red - "no bug" is not "verified". It still does not block (health is `unknown`, never `critical`).
            await attachAnalysisReport(harness, snapshotId, "passed", ["passed", "passed", "scenario_issue"]);

            const history = await harness.request().branches.snapshotHistory({ branchId });
            const row = history.find((s) => s.id === snapshotId);

            expect(row?.summary?.tone).toBe("warning");
            expect(row?.summary?.label).toBe("Not confirmed");
            expect(row?.summary?.reason).toBe("1 couldn't confirm");
            expect(row?.summary?.analysis?.bugCount).toBe(0);
            expect(row?.health).toBe("unknown");
        });

        test("reads a run that confirmed nothing as 'Not confirmed' from the report, even with no surviving findings", async ({
            harness,
        }) => {
            const { branchId } = await createBranch(harness);
            const snapshotId = await createSnapshot(harness, branchId, "head-blocked");
            // The report outlives its findings' classifications (discarding a generation cascades its
            // classification away), so the badge must read 7 tests / 7 coverage off the report - not the empty
            // finding tally, which would read as a clean, passing run.
            await harness.db.analysisJob.create({
                data: { snapshotId, status: "completed", organizationId: harness.organizationId },
            });
            await harness.db.analysisReport.create({
                data: {
                    snapshotId,
                    verdict: "passed",
                    clientBugCount: 0,
                    testCount: 7,
                    coverage: { total: 7, byCategory: [{ category: "engine_artifact", count: 7 }] },
                    summary: "All seven checks were blocked before the app was exercised.",
                    reportMarkdown: "## Run\n\nBlocked.",
                    organizationId: harness.organizationId,
                },
            });

            const history = await harness.request().branches.snapshotHistory({ branchId });
            const row = history.find((s) => s.id === snapshotId);

            expect(row?.summary?.tone).toBe("warning");
            expect(row?.summary?.label).toBe("Not confirmed");
            expect(row?.summary?.reason).toBe("7 blocked");
            expect(row?.summary?.analysis).toEqual({
                jobStatus: "completed",
                bugCount: 0,
                passedCount: 0,
                coverageCount: 7,
            });
            expect(row?.health).toBe("unknown");
        });

        test("a legacy diffs snapshot carries no authoritative analysis on its summary", async ({ harness }) => {
            const { branchId } = await createBranch(harness);
            const snapshotId = await createSnapshot(harness, branchId, "head-legacy");
            await harness.db.diffsJob.create({
                data: { snapshotId, status: "completed", organizationId: harness.organizationId },
            });

            const history = await harness.request().branches.snapshotHistory({ branchId });
            const row = history.find((s) => s.id === snapshotId);

            expect(row?.summary?.analysis).toBeUndefined();
        });
    },
});
