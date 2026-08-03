import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedAnalysisFindings } from "../seed-analysis-findings";

/**
 * `branches.mainOpenProblems` is the one presenter for what is still unresolved on main. The store it reads is
 * decided by whether the merged pipeline has EVER run on main: such an application gets its `AnalysisIssue` rows,
 * and one that has not keeps its deprecated `Bug` rows unchanged. The choice is deliberately branch-scoped rather
 * than read off main's active snapshot, which moves for reasons unrelated to analysis.
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

/** Marks a snapshot as an authoritative analysis run, the way the trigger does. */
async function runAnalysisOn(harness: APITestHarness, snapshotId: string): Promise<void> {
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

async function createBug(
    harness: APITestHarness,
    app: SeededApp,
    bug: { title: string; severity: string; status?: string },
): Promise<string> {
    const created = await harness.db.bug.create({
        data: {
            title: bug.title,
            description: `${bug.title} - what happened.`,
            severity: bug.severity,
            status: bug.status ?? "open",
            resolvedAt: bug.status === "resolved" ? new Date() : undefined,
            branchId: app.mainBranchId,
            applicationId: app.applicationId,
            organizationId: harness.organizationId,
        },
    });
    return created.id;
}

apiTestSuite({
    name: "branches.mainOpenProblems",
    cases: (test) => {
        test("an application whose main has no analysis job keeps reading its legacy bugs", async ({ harness }) => {
            const app = await createApp(harness, `Legacy ${crypto.randomUUID()}`);
            await createActiveSnapshot(harness, app.mainBranchId, "head-legacy");

            const openBugId = await createBug(harness, app, { title: "Checkout hangs", severity: "critical" });
            const resolvedBugId = await createBug(harness, app, {
                title: "Fixed already",
                severity: "high",
                status: "resolved",
            });
            // An issue on main is invisible to the legacy arm: this application has not run analysis on main.
            await createIssue(harness, app.mainBranchId, {
                title: "Shadow issue",
                kind: "bug",
                severity: "critical",
            });

            const result = await harness.request().branches.mainOpenProblems({ applicationId: app.applicationId });

            expect(result.source).toBe("legacy_bug");
            expect(result.problems.map((problem) => problem.id)).toEqual([openBugId]);
            expect(result.problems[0]?.kind).toBe("bug");
            expect(result.problems[0]?.detail).toBe("Checkout hangs - what happened.");
            expect(result.problems.map((problem) => problem.id)).not.toContain(resolvedBugId);
        });

        test("the legacy arm includes regressed bugs, most severe first", async ({ harness }) => {
            const app = await createApp(harness, `Regressed ${crypto.randomUUID()}`);
            await createActiveSnapshot(harness, app.mainBranchId, "head-regressed");

            const regressedId = await createBug(harness, app, {
                title: "Coupon removal regressed",
                severity: "critical",
                status: "regressed",
            });
            const openId = await createBug(harness, app, { title: "Avatar upload fails", severity: "low" });

            const result = await harness.request().branches.mainOpenProblems({ applicationId: app.applicationId });

            expect(result.problems.map((problem) => problem.id)).toEqual([regressedId, openId]);
        });

        test("an application whose main ran analysis reads its open issues instead, bugs first", async ({
            harness,
        }) => {
            const app = await createApp(harness, `Analyzed ${crypto.randomUUID()}`);
            const snapshotId = await createActiveSnapshot(harness, app.mainBranchId, "head-analysis");
            await runAnalysisOn(harness, snapshotId);

            // A legacy bug still on the row must not resurface once analysis owns main.
            const legacyBugId = await createBug(harness, app, { title: "Stale legacy bug", severity: "critical" });

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

            const result = await harness.request().branches.mainOpenProblems({ applicationId: app.applicationId });

            expect(result.source).toBe("analysis_issue");
            // Bugs come first even when a coverage-plane issue is more severe - the shared issue ordering.
            expect(result.problems.map((problem) => problem.id)).toEqual([bugIssueId, environmentIssueId]);
            expect(result.problems.map((problem) => problem.id)).not.toContain(resolvedIssueId);
            expect(result.problems.map((problem) => problem.id)).not.toContain(legacyBugId);
        });

        test("stays authoritative after a job-less snapshot is activated on main", async ({ harness }) => {
            const app = await createApp(harness, `Edited ${crypto.randomUUID()}`);
            const analysedSnapshotId = await createActiveSnapshot(harness, app.mainBranchId, "head-analysis");
            await runAnalysisOn(harness, analysedSnapshotId);

            const issueId = await createIssue(harness, app.mainBranchId, {
                title: "Publishing leaves the supplier total stale",
                kind: "bug",
                severity: "high",
            });
            const legacyBugId = await createBug(harness, app, { title: "Stale legacy bug", severity: "critical" });

            // A suite edit or an SDK plan upload activates a snapshot the pipeline never ran, so main's active
            // pointer no longer names an analysis run. The branch has still run analysis, and its issues still
            // stand - a gate on the active snapshot alone would revert to the legacy store and hide them.
            await createActiveSnapshot(harness, app.mainBranchId, "head-suite-edit");

            const result = await harness.request().branches.mainOpenProblems({ applicationId: app.applicationId });

            expect(result.source).toBe("analysis_issue");
            expect(result.problems.map((problem) => problem.id)).toEqual([issueId]);
            expect(result.problems.map((problem) => problem.id)).not.toContain(legacyBugId);
        });

        test("an issue's recurrence counts distinct runs and dates from the newest covering finding", async ({
            harness,
        }) => {
            const app = await createApp(harness, `Recurring ${crypto.randomUUID()}`);
            const olderSnapshotId = await createActiveSnapshot(harness, app.mainBranchId, "head-older");
            await runAnalysisOn(harness, olderSnapshotId);
            const newerSnapshotId = await createActiveSnapshot(harness, app.mainBranchId, "head-newer");
            await runAnalysisOn(harness, newerSnapshotId);

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

            const result = await harness.request().branches.mainOpenProblems({ applicationId: app.applicationId });

            expect(result.problems).toHaveLength(1);
            expect(result.problems[0]?.occurrences).toBe(2);
            expect(result.problems[0]?.lastSeenAt).toEqual(newestFinding.createdAt);
        });
    },
});
