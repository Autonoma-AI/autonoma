import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedAnalysisFindings } from "../seed-analysis-findings";

/**
 * The checkpoint-history rail (branches.snapshotHistory) must read an authoritative snapshot's badge from the run's
 * finding categories and the branch's open bug issues, not the legacy health/Bug model the merged pipeline never
 * populates. A snapshot with no analysis job carries no analysis summary at all.
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

async function attachAnalysisReport(harness: APITestHarness, snapshotId: string, categories: string[]): Promise<void> {
    await harness.db.analysisJob.create({
        data: { snapshotId, status: "completed", organizationId: harness.organizationId },
    });
    // The badge derives its counts from the findings below (the coverage-plane total and the test count) plus the
    // branch's open bug issues - not from the report, which now holds only the Reporter's authored prose.
    await harness.db.analysisReport.create({
        data: {
            snapshotId,
            title: "Autonoma checked this PR",
            headline: "The run's authored headline.",
            reportMarkdown: "## Run\n\nWhat it found.",
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
            await attachAnalysisReport(harness, snapshotId, ["client_bug", "passed", "passed", "engine_artifact"]);

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

        test("an authoritative checkpoint with a coverage gap reads its ratio, non-blocking", async ({ harness }) => {
            const { branchId } = await createBranch(harness);
            const snapshotId = await createSnapshot(harness, branchId, "head-pass");
            // No client bugs, but a coverage gap means the change was not fully confirmed - "no bug" is not
            // "verified". Stated as a ratio in a neutral tone rather than an amber alarm, since only a bug is raised
            // as a problem; it still does not block (health is `unknown`, never `critical`).
            await attachAnalysisReport(harness, snapshotId, ["passed", "passed", "scenario_issue"]);

            const history = await harness.request().branches.snapshotHistory({ branchId });
            const row = history.find((s) => s.id === snapshotId);

            expect(row?.summary?.tone).toBe("neutral");
            expect(row?.summary?.label).toBe("2/3 verified");
            expect(row?.summary?.reason).toBe("1 couldn't complete");
            expect(row?.summary?.analysis?.bugCount).toBe(0);
            expect(row?.health).toBe("unknown");
        });

        test("reads a run that confirmed nothing as a zero ratio, even when every finding is a coverage gap", async ({
            harness,
        }) => {
            const { branchId } = await createBranch(harness);
            const snapshotId = await createSnapshot(harness, branchId, "head-blocked");
            // Seven tests blocked before the app was exercised. "No bug" is not "verified", so this must not read
            // green just because nothing was judged a bug.
            await harness.db.analysisJob.create({
                data: { snapshotId, status: "completed", organizationId: harness.organizationId },
            });
            await seedCoverageFindings(harness, snapshotId, 7);
            await harness.db.analysisReport.create({
                data: {
                    snapshotId,
                    title: "Autonoma checked this PR",
                    headline: "All seven checks were blocked before the app was exercised.",
                    reportMarkdown: "## Run\n\nBlocked.",
                    organizationId: harness.organizationId,
                },
            });

            const history = await harness.request().branches.snapshotHistory({ branchId });
            const row = history.find((s) => s.id === snapshotId);

            expect(row?.summary?.tone).toBe("neutral");
            expect(row?.summary?.label).toBe("0/7 verified");
            expect(row?.summary?.reason).toBe("7 couldn't complete");
            expect(row?.summary?.analysis).toEqual({
                jobStatus: "completed",
                bugCount: 0,
                passedCount: 0,
                coverageCount: 7,
            });
            expect(row?.health).toBe("unknown");
        });

        test("a snapshot with no AnalysisJob carries no analysis on its summary", async ({ harness }) => {
            const { branchId } = await createBranch(harness);
            const snapshotId = await createSnapshot(harness, branchId, "head-no-job");

            const history = await harness.request().branches.snapshotHistory({ branchId });
            const row = history.find((s) => s.id === snapshotId);

            expect(row?.summary?.analysis).toBeUndefined();
        });
    },
});

/** N tests this run could not exercise: the coverage plane, one engine artifact per test. */
async function seedCoverageFindings(harness: APITestHarness, snapshotId: string, count: number): Promise<void> {
    await seedAnalysisFindings(
        harness.db,
        snapshotId,
        Array.from({ length: count }, (_, index) => ({ slug: `blocked-${index}`, category: "engine_artifact" })),
    );
}
