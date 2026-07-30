import { ApplicationArchitecture, type Application } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedAnalysisFindings } from "../seed-analysis-findings";

/**
 * The read behind the MCP `get_analysis` tool. Every case drives the service directly (the tool is a thin wrapper
 * over it), and each gets its OWN branch: `feature_branch_info` is 1:1 with a branch, so two PRs cannot share one.
 */
apiTestSuite({
    name: "branches.getAnalysisForPr",
    seed: async ({ harness }) => ({ application: await createApplication(harness) }),
    cases: (test) => {
        test("reports no analysis for a PR that has no run", async ({ harness, seedResult: { application } }) => {
            const { prNumber } = await createPrBranch(harness, application.id, 7001);

            const analysis = await harness.services.branches.getAnalysisForPr(
                application.id,
                prNumber,
                harness.organizationId,
            );

            // Distinct from a clean pass: the caller must be able to point the reader at the legacy pipeline instead
            // of reporting that there is nothing to fix.
            expect(analysis.status).toBe("no_analysis");
        });

        test("reports no analysis for a PR number that does not exist", async ({
            harness,
            seedResult: { application },
        }) => {
            const analysis = await harness.services.branches.getAnalysisForPr(
                application.id,
                999_999,
                harness.organizationId,
            );

            expect(analysis.status).toBe("no_analysis");
        });

        test("reports a run in progress while it has no report yet", async ({
            harness,
            seedResult: { application },
        }) => {
            const { branchId, prNumber } = await createPrBranch(harness, application.id, 7002);
            await createRun(harness, branchId, { headSha: "sha-running", jobStatus: "running" });

            const analysis = await harness.services.branches.getAnalysisForPr(
                application.id,
                prNumber,
                harness.organizationId,
            );

            expect(analysis.status).toBe("in_progress");
        });

        test("reports a failed run, with its reason, when it produced no report", async ({
            harness,
            seedResult: { application },
        }) => {
            const { branchId, prNumber } = await createPrBranch(harness, application.id, 7003);
            await createRun(harness, branchId, {
                headSha: "sha-failed",
                jobStatus: "failed",
                failureReason: "The preview never became reachable.",
            });

            const analysis = await harness.services.branches.getAnalysisForPr(
                application.id,
                prNumber,
                harness.organizationId,
            );

            expect(analysis).toMatchObject({
                status: "failed",
                failureReason: "The preview never became reachable.",
            });
        });

        test("reports a clean PR as complete with no issues", async ({ harness, seedResult: { application } }) => {
            const { branchId, prNumber } = await createPrBranch(harness, application.id, 7004);
            const { snapshotId } = await createRun(harness, branchId, { headSha: "sha-clean" });
            await createReport(harness, snapshotId, { verdict: "passed", testCount: 3, clientBugCount: 0 });

            const analysis = await harness.services.branches.getAnalysisForPr(
                application.id,
                prNumber,
                harness.organizationId,
            );

            if (analysis.status !== "complete") throw new Error(`Expected complete, got ${analysis.status}`);
            expect(analysis.verdict).toBe("passed");
            expect(analysis.issues).toEqual([]);
            expect(analysis.testCount).toBe(3);
        });

        test("returns every open issue kind, most actionable first, with its evidence and links", async ({
            harness,
            seedResult: { application },
        }) => {
            const { branchId, prNumber } = await createPrBranch(harness, application.id, 7005);
            const { snapshotId } = await createRun(harness, branchId, { headSha: "sha-issues" });
            await createReport(harness, snapshotId, {
                verdict: "client_bug",
                testCount: 3,
                clientBugCount: 1,
                impactReasoning: "Selected the checkout tests because the PR touches the cart.",
                coverage: { byCategory: [{ category: "environment_failure", count: 1 }], total: 1 },
            });
            const findingFor = await seedAnalysisFindings(harness.db, snapshotId, [
                {
                    slug: "checkout-submit",
                    category: "client_bug",
                    classification: { clipKey: "s3://bucket/checkout.gif" },
                    origin: "pre_existing",
                    selectionReason: "The PR edits the cart reducer this test drives.",
                },
                { slug: "login-loads", category: "environment_failure" },
                {
                    slug: "cart-seeded",
                    category: "scenario_issue",
                    origin: "proposed",
                    selectionReason: "The PR adds a saved-cart flow no test covered.",
                },
            ]);
            const testCaseIdFor = await testCaseIds(harness, application.id);

            // A bug, plus the two kinds an agent fixes in Autonoma rather than in the repo.
            await createIssue(harness, branchId, {
                title: "Submit never enables",
                kind: "scenario",
                severity: "low",
                actualBehavior: "The cart fixture seeded no line items.",
                slugs: ["cart-seeded"],
                primaryTestCaseId: testCaseIdFor("cart-seeded"),
            });
            await createIssue(harness, branchId, {
                title: "Preview was unreachable",
                kind: "environment",
                severity: "high",
                actualBehavior: "Every request to the preview timed out.",
                slugs: ["login-loads"],
                primaryTestCaseId: testCaseIdFor("login-loads"),
            });
            await createIssue(harness, branchId, {
                title: "Checkout submit stays disabled",
                kind: "bug",
                severity: "critical",
                actualBehavior: "The submit button stays disabled after the form is filled.",
                expectedBehavior: "Submitting a filled form places the order.",
                suspectedCause: {
                    explanation: "The disabled prop reads a stale validity flag.",
                    codeReferences: [{ file: "src/checkout/form.tsx", lines: "42-58", snippet: "disabled={!valid}" }],
                },
                primaryScreenshot: { s3Key: "s3://bucket/checkout.png" },
                slugs: ["checkout-submit"],
                primaryTestCaseId: testCaseIdFor("checkout-submit"),
            });

            const analysis = await harness.services.branches.getAnalysisForPr(
                application.id,
                prNumber,
                harness.organizationId,
            );

            if (analysis.status !== "complete") throw new Error(`Expected complete, got ${analysis.status}`);
            // Bugs first, then the coverage-plane kinds by descending severity - the shared ordering.
            expect(analysis.issues.map((issue) => issue.kind)).toEqual(["bug", "environment", "scenario"]);
            expect(analysis.impactReasoning).toContain("checkout");
            expect(analysis.coverage?.total).toBe(1);

            const bug = analysis.issues[0];
            expect(bug?.expectedBehavior).toContain("places the order");
            expect(bug?.suspectedCause?.codeReferences[0]?.file).toBe("src/checkout/form.tsx");
            expect(bug?.screenshotUrl).not.toContain("s3://");
            expect(bug?.clipUrl).not.toContain("s3://");
            // The two links mean different things: the branch-scoped issue, and the run that reproduces it.
            expect(bug?.issueUrl).toContain(`/pull-requests/${prNumber}/issues/${bug?.id}`);
            expect(bug?.replayUrl).toContain(`/snapshots/${snapshotId}/findings/${findingFor("checkout-submit")}`);
            // The covered test carries Impact Analysis's account of why the run exercised it, so a reader can tell an
            // issue found by a test the PR touched from one found by a test the run authored for new functionality.
            expect(bug?.coveredTests).toEqual([
                {
                    slug: "checkout-submit",
                    origin: "pre_existing",
                    selectionReason: "The PR edits the cart reducer this test drives.",
                    category: "client_bug",
                },
            ]);
            expect(bug?.runCount).toBe(1);

            const scenario = analysis.issues[2];
            expect(scenario?.coveredTests).toEqual([
                {
                    slug: "cart-seeded",
                    origin: "proposed",
                    selectionReason: "The PR adds a saved-cart flow no test covered.",
                    category: "scenario_issue",
                },
            ]);
        });

        test("keeps serving the previous run's issues while a newer run is still going", async ({
            harness,
            seedResult: { application },
        }) => {
            const { branchId, prNumber } = await createPrBranch(harness, application.id, 7006);
            const first = await createRun(harness, branchId, { headSha: "sha-first" });
            await createReport(harness, first.snapshotId, { verdict: "client_bug", clientBugCount: 1 });
            await createIssue(harness, branchId, {
                title: "Still open from the last run",
                kind: "bug",
                severity: "high",
                actualBehavior: "The order never submits.",
            });
            // A newer push started a run that has not reported yet.
            await createRun(harness, branchId, {
                headSha: "sha-second",
                jobStatus: "running",
                createdAt: new Date(Date.now() + 60_000),
            });

            const analysis = await harness.services.branches.getAnalysisForPr(
                application.id,
                prNumber,
                harness.organizationId,
            );

            // Reporting "in progress" here would withhold issues the reader can already act on, so the newer run is
            // a caveat ON the previous result, not a replacement for it.
            if (analysis.status !== "complete") throw new Error(`Expected complete, got ${analysis.status}`);
            expect(analysis.issues).toHaveLength(1);
            expect(analysis.newerRun).toEqual({ status: "running" });
        });

        test("flags that the newest run failed while still serving the previous run's issues", async ({
            harness,
            seedResult: { application },
        }) => {
            const { branchId, prNumber } = await createPrBranch(harness, application.id, 7010);
            const first = await createRun(harness, branchId, { headSha: "sha-reported" });
            await createReport(harness, first.snapshotId, { verdict: "client_bug", clientBugCount: 1 });
            await createIssue(harness, branchId, {
                title: "Open from the reported run",
                kind: "bug",
                severity: "high",
                actualBehavior: "The order never submits.",
            });
            await createRun(harness, branchId, {
                headSha: "sha-crashed",
                jobStatus: "failed",
                failureReason: "The preview never became reachable.",
                createdAt: new Date(Date.now() + 60_000),
            });

            const analysis = await harness.services.branches.getAnalysisForPr(
                application.id,
                prNumber,
                harness.organizationId,
            );

            // The reader needs both halves: there ARE issues to act on, and the newest attempt did not land, so this
            // describes the previous run rather than the current head.
            if (analysis.status !== "complete") throw new Error(`Expected complete, got ${analysis.status}`);
            expect(analysis.issues).toHaveLength(1);
            expect(analysis.newerRun).toEqual({
                status: "failed",
                failureReason: "The preview never became reachable.",
            });
        });

        test("skips an issue whose severity is malformed, keeping its siblings", async ({
            harness,
            seedResult: { application },
        }) => {
            const { branchId, prNumber } = await createPrBranch(harness, application.id, 7007);
            const { snapshotId } = await createRun(harness, branchId, { headSha: "sha-malformed" });
            await createReport(harness, snapshotId, { verdict: "client_bug", clientBugCount: 1 });
            await createIssue(harness, branchId, {
                title: "Unreadable severity",
                kind: "bug",
                severity: "catastrophic",
                actualBehavior: "Stored outside the taxonomy.",
            });
            await createIssue(harness, branchId, {
                title: "Readable",
                kind: "bug",
                severity: "high",
                actualBehavior: "The order never submits.",
            });

            const analysis = await harness.services.branches.getAnalysisForPr(
                application.id,
                prNumber,
                harness.organizationId,
            );

            if (analysis.status !== "complete") throw new Error(`Expected complete, got ${analysis.status}`);
            expect(analysis.issues.map((issue) => issue.title)).toEqual(["Readable"]);
        });

        test("does not serve a PR to another organization", async ({ harness, seedResult: { application } }) => {
            const { branchId, prNumber } = await createPrBranch(harness, application.id, 7008);
            const { snapshotId } = await createRun(harness, branchId, { headSha: "sha-scoped" });
            await createReport(harness, snapshotId, { verdict: "client_bug", clientBugCount: 1 });

            const analysis = await harness.services.branches.getAnalysisForPr(
                application.id,
                prNumber,
                "org_someone_else",
            );

            expect(analysis.status).toBe("no_analysis");
        });

        test("resolves an issue's designated run to the newest snapshot that reproduced it", async ({
            harness,
            seedResult: { application },
        }) => {
            const { branchId, prNumber } = await createPrBranch(harness, application.id, 7009);
            const older = await createRun(harness, branchId, { headSha: "sha-older" });
            const newer = await createRun(harness, branchId, {
                headSha: "sha-newer",
                createdAt: new Date(Date.now() + 60_000),
            });
            await createReport(harness, newer.snapshotId, { verdict: "client_bug", clientBugCount: 1 });
            await seedAnalysisFindings(harness.db, older.snapshotId, [{ slug: "recurring", category: "client_bug" }]);
            const findingFor = await seedAnalysisFindings(harness.db, newer.snapshotId, [
                { slug: "recurring", category: "client_bug" },
            ]);
            const testCaseIdFor = await testCaseIds(harness, application.id);
            await createIssue(harness, branchId, {
                title: "Recurring across pushes",
                kind: "bug",
                severity: "high",
                actualBehavior: "The order never submits.",
                slugs: ["recurring"],
                primaryTestCaseId: testCaseIdFor("recurring"),
            });

            const analysis = await harness.services.branches.getAnalysisForPr(
                application.id,
                prNumber,
                harness.organizationId,
            );

            if (analysis.status !== "complete") throw new Error(`Expected complete, got ${analysis.status}`);
            const issue = analysis.issues[0];
            // Recurrence counts distinct runs, and the replay tracks the latest one with no re-designation.
            expect(issue?.runCount).toBe(2);
            expect(issue?.replayUrl).toContain(`/snapshots/${newer.snapshotId}/findings/${findingFor("recurring")}`);
        });
    },
});

async function createApplication(harness: APITestHarness): Promise<Application> {
    return await harness.services.applications.createApplication({
        name: `Analysis For PR ${crypto.randomUUID()}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/default-file.png",
    });
}

/** A branch attached to a pull request - the resolution key `get_analysis` is called with. */
async function createPrBranch(
    harness: APITestHarness,
    applicationId: string,
    prNumber: number,
): Promise<{ branchId: string; prNumber: number }> {
    const branch = await harness.db.branch.create({
        data: {
            name: `feature/pr-${prNumber}`,
            applicationId,
            organizationId: harness.organizationId,
        },
    });
    await harness.db.featureBranchInfo.create({ data: { branchId: branch.id, applicationId, prNumber } });
    return { branchId: branch.id, prNumber };
}

/** One analysis run on a branch: a snapshot plus the `AnalysisJob` that tracks its lifecycle. */
async function createRun(
    harness: APITestHarness,
    branchId: string,
    {
        headSha,
        jobStatus = "completed",
        failureReason,
        createdAt,
    }: { headSha: string; jobStatus?: "running" | "completed" | "failed"; failureReason?: string; createdAt?: Date },
): Promise<{ snapshotId: string }> {
    const snapshot = await harness.db.branchSnapshot.create({
        data: { branchId, source: "GITHUB_PUSH", headSha, createdAt },
    });
    await harness.db.analysisJob.create({
        data: {
            snapshotId: snapshot.id,
            status: jobStatus,
            failureReason,
            organizationId: harness.organizationId,
        },
    });
    return { snapshotId: snapshot.id };
}

async function createReport(
    harness: APITestHarness,
    snapshotId: string,
    {
        verdict,
        testCount = 1,
        clientBugCount = 0,
        impactReasoning,
        coverage,
    }: {
        verdict: string;
        testCount?: number;
        clientBugCount?: number;
        impactReasoning?: string;
        coverage?: { byCategory: { category: string; count: number }[]; total: number };
    },
): Promise<void> {
    await harness.db.analysisReport.create({
        data: {
            snapshotId,
            verdict,
            testCount,
            clientBugCount,
            impactReasoning,
            coverage,
            summary: "One paragraph about the run.",
            reportMarkdown: "## The run\n\nWhat it found.",
            organizationId: harness.organizationId,
        },
    });
}

/**
 * One open issue, optionally attributed to the findings for `slugs` (the attribution the Reporter backfills, which
 * is what makes an issue's covered tests and recurrence real rather than a list of strings).
 */
async function createIssue(
    harness: APITestHarness,
    branchId: string,
    {
        title,
        kind,
        severity,
        actualBehavior,
        expectedBehavior,
        suspectedCause,
        primaryScreenshot,
        primaryTestCaseId,
        slugs = [],
    }: {
        title: string;
        kind: string;
        severity: string;
        actualBehavior: string;
        expectedBehavior?: string;
        suspectedCause?: object;
        primaryScreenshot?: object;
        primaryTestCaseId?: string;
        slugs?: string[];
    },
): Promise<string> {
    const issue = await harness.db.analysisIssue.create({
        data: {
            branchId,
            organizationId: harness.organizationId,
            title,
            kind,
            severity,
            status: "open",
            actualBehavior,
            expectedBehavior,
            narrativeMarkdown: `## ${title}\n\n${actualBehavior}`,
            suspectedCause,
            primaryScreenshot,
            primaryTestCaseId,
        },
    });
    if (slugs.length > 0) {
        await harness.db.analysisFinding.updateMany({
            where: { organizationId: harness.organizationId, testCase: { slug: { in: slugs } } },
            data: { issueId: issue.id },
        });
    }
    return issue.id;
}

/** Slug -> TestCase id for the application, so an issue can designate its primary test. */
async function testCaseIds(harness: APITestHarness, applicationId: string): Promise<(slug: string) => string> {
    const cases = await harness.db.testCase.findMany({ where: { applicationId }, select: { id: true, slug: true } });
    const byslug = new Map(cases.map((testCase) => [testCase.slug, testCase.id]));
    return (slug) => {
        const id = byslug.get(slug);
        if (id == null) throw new Error(`No test case seeded for slug "${slug}"`);
        return id;
    };
}
