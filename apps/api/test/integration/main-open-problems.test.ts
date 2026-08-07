import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedAnalysisFindings } from "../seed-analysis-findings";

/**
 * `branches.mainOpenProblems` is the one presenter for what is still unresolved on main: the open `AnalysisIssue`
 * rows on the application's main branch, bugs-first then by descending severity. It reads the branch rather than
 * main's active snapshot, which moves for reasons unrelated to analysis.
 */

interface SeededApp {
    applicationId: string;
    mainBranchId: string;
}

async function createApp(harness: APITestHarness, name: string): Promise<SeededApp> {
    const application = await harness.services.applications.createApplication({
        name,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });
    if (application.mainBranchId == null) throw new Error("expected application to have a main branch");
    return { applicationId: application.id, mainBranchId: application.mainBranchId };
}

/** A snapshot promoted to the branch's active pointer, as `TestSuiteUpdater.finalize` leaves it. */
async function createActiveSnapshot(harness: APITestHarness, branchId: string, headSha: string): Promise<string> {
    const snapshot = await harness.db.branchSnapshot.create({
        data: { branchId, source: "GITHUB_PUSH", status: "active", baseSha: "base", headSha },
    });
    await harness.db.branch.update({ where: { id: branchId }, data: { activeSnapshotId: snapshot.id } });
    return snapshot.id;
}

/**
 * An analysis run on the snapshot. Not read by `mainOpenProblems`, which is branch-scoped - this exists because
 * `analysis_finding.report_snapshot_id` FKs `analysis_job.snapshot_id`, so a run must exist to attach findings.
 */
async function createAnalysisRun(harness: APITestHarness, snapshotId: string): Promise<void> {
    await harness.db.analysisJob.create({
        data: { snapshotId, status: "completed", organizationId: harness.organizationId },
    });
}

async function createIssue(
    harness: APITestHarness,
    branchId: string,
    issue: { title: string; kind: string; severity: string; status?: string; actualBehavior?: string },
): Promise<string> {
    const created = await harness.db.analysisIssue.create({
        data: {
            branchId,
            title: issue.title,
            kind: issue.kind,
            severity: issue.severity,
            status: issue.status ?? "open",
            actualBehavior: issue.actualBehavior ?? `${issue.title} - what happened.`,
            narrativeMarkdown: `## ${issue.title}`,
            organizationId: harness.organizationId,
        },
    });
    return created.id;
}

apiTestSuite({
    name: "branches.mainOpenProblems",
    cases: (test) => {
        test("reads main's open issues, bugs first", async ({ harness }) => {
            const app = await createApp(harness, `Analyzed ${crypto.randomUUID()}`);
            await createActiveSnapshot(harness, app.mainBranchId, "head-analysis");

            const environmentIssueId = await createIssue(harness, app.mainBranchId, {
                title: "Preview OCR service unreachable",
                kind: "environment",
                severity: "critical",
            });
            const bugIssueId = await createIssue(harness, app.mainBranchId, {
                title: "Publishing leaves the supplier total stale",
                kind: "bug",
                severity: "medium",
            });
            const resolvedIssueId = await createIssue(harness, app.mainBranchId, {
                title: "Already resolved",
                kind: "bug",
                severity: "critical",
                status: "resolved",
            });

            const problems = await harness.request().branches.mainOpenProblems({ applicationId: app.applicationId });
            // Bugs come first even when a coverage-plane issue is more severe - the shared issue ordering.
            expect(problems.map((problem) => problem.id)).toEqual([bugIssueId, environmentIssueId]);
            expect(problems.map((problem) => problem.id)).not.toContain(resolvedIssueId);
        });

        test("an issue's recurrence counts distinct runs and dates from the newest covering finding", async ({
            harness,
        }) => {
            const app = await createApp(harness, `Recurring ${crypto.randomUUID()}`);
            const olderSnapshotId = await createActiveSnapshot(harness, app.mainBranchId, "head-older");
            await createAnalysisRun(harness, olderSnapshotId);
            const newerSnapshotId = await createActiveSnapshot(harness, app.mainBranchId, "head-newer");
            await createAnalysisRun(harness, newerSnapshotId);

            const issueId = await createIssue(harness, app.mainBranchId, {
                title: "Carried across two runs",
                kind: "bug",
                severity: "high",
            });

            // Two runs, and the older one attributed two tests to the same issue: recurrence is 2 runs, not 3 rows.
            const older = await seedAnalysisFindings(harness.db, olderSnapshotId, [
                { slug: "publish-invoice", category: "client_bug" },
                { slug: "review-invoice", category: "client_bug" },
            ]);
            const newer = await seedAnalysisFindings(harness.db, newerSnapshotId, [
                { slug: "publish-invoice", category: "client_bug" },
            ]);
            const newestFindingId = newer("publish-invoice");
            await harness.db.analysisFinding.updateMany({
                where: { id: { in: [older("publish-invoice"), older("review-invoice"), newestFindingId] } },
                data: { issueId },
            });
            const newestFinding = await harness.db.analysisFinding.findUniqueOrThrow({
                where: { id: newestFindingId },
                select: { createdAt: true },
            });

            const problems = await harness.request().branches.mainOpenProblems({ applicationId: app.applicationId });

            expect(problems).toHaveLength(1);
            expect(problems[0]?.occurrences).toBe(2);
            expect(problems[0]?.lastSeenAt).toEqual(newestFinding.createdAt);
        });
    },
});
