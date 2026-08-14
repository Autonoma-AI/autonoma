import { expect } from "vitest";
import { AnalysisCoverageGapError, IssueNotOnBranchError } from "../src/errors";
import type { IssueContent } from "../src/settle-report";
import { analysisSuite } from "./harness";

function bugContent(title: string, coveredTestSlugs: string[]): IssueContent {
    return {
        title,
        kind: "bug",
        severity: "high",
        actualBehavior: `${title} misbehaves`,
        narrativeMarkdown: `${title} narrative`,
        evidenceManifest: [],
        coveredTestSlugs,
        primaryTestSlug: coveredTestSlugs[0] ?? "",
    };
}

analysisSuite({
    name: "Analysis",
    cases: (test) => {
        test("settleReport commits the reconciliations, the attributions and the report together", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            const { findingId } = await harness.recordVerdict(run, "checkout", "client_bug");
            const scope = harness.store.forAnalysis(run.snapshotId);

            const result = await scope.settleReport(
                harness.settlement([{ kind: "open", content: bugContent("Checkout broken", ["checkout"]) }]),
            );

            expect(result).toEqual({
                settled: true,
                verdict: "client_bug",
                clientBugCount: 1,
                testCount: 1,
                issuesOpened: 1,
                issuesCarried: 0,
                issuesResolved: 0,
            });
            const issues = await harness.db.analysisIssue.findMany({ where: { branchId: run.branchId } });
            expect(issues).toHaveLength(1);
            const finding = await harness.db.analysisFinding.findUniqueOrThrow({ where: { id: findingId } });
            expect(finding.issueId).toBe(issues[0]?.id);
            const report = await harness.db.analysisReport.findUniqueOrThrow({
                where: { snapshotId: run.snapshotId },
            });
            expect(report.verdict).toBe("client_bug");
            expect(report.clientBugCount).toBe(1);
        });

        test("a failure between the issue writes and the report leaves neither", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            await harness.recordVerdict(run, "checkout", "client_bug");
            const scope = harness.store.forAnalysis(run.snapshotId);

            // The second reconciliation names an issue on a different branch, which throws after the first
            // reconciliation already created its issue - the transaction must take that issue down with it.
            const foreign = await harness.seedAnalysis();
            const foreignIssue = await harness.seedIssue({
                branchId: foreign.branchId,
                organizationId: foreign.organizationId,
                title: "Foreign",
                kind: "bug",
                severity: "low",
                actualBehavior: "other branch",
                narrativeMarkdown: "other branch",
            });

            await expect(
                scope.settleReport(
                    harness.settlement([
                        { kind: "open", content: bugContent("Checkout broken", ["checkout"]) },
                        {
                            kind: "resolve",
                            existingIssueId: foreignIssue.id,
                            resolvingTestSlug: "checkout",
                            note: "not ours",
                        },
                    ]),
                ),
            ).rejects.toThrow(IssueNotOnBranchError);

            expect(await harness.db.analysisIssue.count({ where: { branchId: run.branchId } })).toBe(0);
            expect(await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } })).toBeNull();
        });

        test("a Reporter whose snapshot settled while it worked writes no report, opens no issue, and leaves the ledger alone", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            // The branch already carries an open issue a stale resolve would wrongly close.
            const existing = await harness.seedIssue({
                branchId: run.branchId,
                organizationId: run.organizationId,
                title: "Existing bug",
                kind: "bug",
                severity: "high",
                actualBehavior: "misbehaves",
                narrativeMarkdown: "existing",
            });
            const { findingId } = await harness.recordVerdict(run, "checkout", "passed");

            // A newer push supersedes the run after the findings landed but before the Reporter persists.
            await harness.db.branchSnapshot.update({
                where: { id: run.snapshotId },
                data: { status: "cancelled" },
            });

            const result = await harness.store.forAnalysis(run.snapshotId).settleReport(
                harness.settlement([
                    { kind: "resolve", existingIssueId: existing.id, resolvingTestSlug: "checkout", note: "fixed" },
                    { kind: "open", content: bugContent("Stale bug", ["checkout"]) },
                ]),
            );

            expect(result).toEqual({ settled: false, reason: "superseded" });
            expect(await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } })).toBeNull();
            const issue = await harness.db.analysisIssue.findUniqueOrThrow({ where: { id: existing.id } });
            expect(issue.status).toBe("open");
            expect(await harness.db.analysisIssue.count({ where: { branchId: run.branchId } })).toBe(1);
            const finding = await harness.db.analysisFinding.findUniqueOrThrow({ where: { id: findingId } });
            expect(finding.issueId).toBeNull();
        });

        test("re-settling an analysis reports already_settled and does not duplicate its issues", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            await harness.recordVerdict(run, "checkout", "client_bug");
            const scope = harness.store.forAnalysis(run.snapshotId);
            const settlement = harness.settlement([
                { kind: "open", content: bugContent("Checkout broken", ["checkout"]) },
            ]);

            const first = await scope.settleReport(settlement);
            const second = await scope.settleReport(settlement);

            expect(first.settled).toBe(true);
            expect(second).toEqual({ settled: false, reason: "already_settled" });
            expect(await harness.db.analysisIssue.count({ where: { branchId: run.branchId } })).toBe(1);
        });

        test("a resolve persists which passing finding closed the issue and why", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const existing = await harness.seedIssue({
                branchId: run.branchId,
                organizationId: run.organizationId,
                title: "Login bug",
                kind: "bug",
                severity: "high",
                actualBehavior: "login fails",
                narrativeMarkdown: "narrative",
            });
            const { findingId } = await harness.recordVerdict(run, "login", "passed");

            await harness.store.forAnalysis(run.snapshotId).settleReport(
                harness.settlement([
                    {
                        kind: "resolve",
                        existingIssueId: existing.id,
                        resolvingTestSlug: "login",
                        note: "The covering login test re-ran on the new head and passed.",
                    },
                ]),
            );

            const issue = await harness.db.analysisIssue.findUniqueOrThrow({ where: { id: existing.id } });
            expect(issue.status).toBe("resolved");
            expect(issue.resolvedAt).not.toBeNull();
            expect(issue.resolvedByFindingId).toBe(findingId);
            expect(issue.resolutionNote).toBe("The covering login test re-ran on the new head and passed.");
        });

        test("a carry-forward reopening a resolved issue clears its resolution record", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const existing = await harness.seedIssue({
                branchId: run.branchId,
                organizationId: run.organizationId,
                title: "Regressed bug",
                kind: "bug",
                severity: "high",
                actualBehavior: "misbehaves",
                narrativeMarkdown: "narrative",
                status: "resolved",
                resolvedAt: new Date(),
                resolutionNote: "was fixed once",
            });
            await harness.recordVerdict(run, "checkout", "client_bug");

            await harness.store.forAnalysis(run.snapshotId).settleReport(
                harness.settlement([
                    {
                        kind: "carry_forward",
                        existingIssueId: existing.id,
                        content: bugContent("Regressed bug", ["checkout"]),
                    },
                ]),
            );

            const issue = await harness.db.analysisIssue.findUniqueOrThrow({ where: { id: existing.id } });
            expect(issue.status).toBe("open");
            expect(issue.resolvedAt).toBeNull();
            expect(issue.resolvedByFindingId).toBeNull();
            expect(issue.resolutionNote).toBeNull();
        });

        test("a crashed child yields a finding with a failure and zero classifications", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const testCaseId = await harness.findOrCreateTestCase(run, "never-ran");
            const scope = harness.store.forAnalysis(run.snapshotId);

            await scope.recordContainment({
                testCaseId,
                origin: "pre_existing",
                failure: { kind: "investigator_crashed", message: "child workflow timed out" },
            });

            const finding = await harness.db.analysisFinding.findUniqueOrThrow({
                where: { reportSnapshotId_testCaseId: { reportSnapshotId: run.snapshotId, testCaseId } },
                include: { classifications: true },
            });
            expect(finding.failure).toEqual({ kind: "investigator_crashed", message: "child workflow timed out" });
            expect(finding.classifications).toHaveLength(0);
            expect(finding.currentClassificationId).toBeNull();
            // No fake run is started to anchor the containment.
            expect(await harness.db.testGeneration.count({ where: { snapshotId: run.snapshotId } })).toBe(0);

            const findings = await scope.findings();
            expect(findings).toHaveLength(1);
            expect(findings[0]?.failure?.message).toBe("child workflow timed out");
            expect(findings[0]?.current).toBeUndefined();
            expect(findings[0]?.selfHealed).toBe(false);
        });

        test("containing a child that crashed mid-loop keeps the verdict it already filed", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const { testCaseId } = await harness.recordVerdict(run, "checkout", "plan_mismatch");
            const scope = harness.store.forAnalysis(run.snapshotId);

            await scope.recordContainment({
                testCaseId,
                origin: "pre_existing",
                failure: { kind: "investigator_crashed", message: "died during the self-heal re-run" },
            });

            const finding = await harness.db.analysisFinding.findUniqueOrThrow({
                where: { reportSnapshotId_testCaseId: { reportSnapshotId: run.snapshotId, testCaseId } },
                include: { currentClassification: true, classifications: true },
            });
            expect(finding.currentClassification?.category).toBe("plan_mismatch");
            expect(finding.classifications).toHaveLength(1);
            expect(finding.failure).toEqual({
                kind: "investigator_crashed",
                message: "died during the self-heal re-run",
            });
        });

        test("a contained fault still yields a run and a coverage-plane classification with no verdict fields", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            // A scenario-setup fault: the Investigator filed the fault itself, pinned to the run that failed.
            const { generationId, testCaseId } = await harness.seedRunForSlug(run, "flaky");
            const scope = harness.store.forAnalysis(run.snapshotId);

            await scope.recordClassification({
                testCaseId,
                origin: "pre_existing",
                number: 1,
                generationId,
                category: "environment_failure",
                headline: "Scenario setup failed before the app was exercised",
            });

            const finding = await harness.db.analysisFinding.findUniqueOrThrow({
                where: { reportSnapshotId_testCaseId: { reportSnapshotId: run.snapshotId, testCaseId } },
                include: { currentClassification: true },
            });
            expect(finding.failure).toBeNull();
            expect(finding.currentClassification?.category).toBe("environment_failure");
            expect(finding.currentClassification?.generationId).toBe(generationId);
            expect(finding.currentClassification?.evidence).toBeNull();
            expect(finding.currentClassification?.conversationUrl).toBeNull();
        });

        test("resolves plan and video keys from the generation for a row that stored none", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const { testCaseId, generationId } = await harness.seedRunForSlug(run, "checkout");
            // The generation is the single source of these run facts; give it a recording to resolve.
            await harness.db.testGeneration.update({
                where: { id: generationId },
                data: { videoUrl: "s3://gen/video.webm", optimizedVideoUrl: "s3://gen/video.mp4" },
            });
            const generation = await harness.db.testGeneration.findUniqueOrThrow({
                where: { id: generationId },
                select: { testPlan: { select: { prompt: true } } },
            });
            const scope = harness.store.forAnalysis(run.snapshotId);
            await scope.recordClassification({
                testCaseId,
                origin: "pre_existing",
                number: 1,
                generationId,
                category: "client_bug",
                headline: "checkout 500s",
            });

            // The row itself stored no copy of any of the three.
            const stored = await harness.db.analysisClassification.findFirstOrThrow({ where: { generationId } });
            expect(stored.plan).toBeNull();
            expect(stored.videoKey).toBeNull();
            expect(stored.optimizedVideoKey).toBeNull();

            // ...yet the finding still carries them, resolved through the generation join.
            const [finding] = await scope.findings();
            expect(finding?.current?.plan).toBe(generation.testPlan.prompt);
            expect(finding?.current?.videoKey).toBe("s3://gen/video.webm");
            expect(finding?.current?.optimizedVideoKey).toBe("s3://gen/video.mp4");
        });

        test("a historical row reads plan and video keys off the generation, ignoring its frozen copies", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            const { testCaseId, generationId } = await harness.seedRunForSlug(run, "legacy");
            await harness.db.testGeneration.update({
                where: { id: generationId },
                data: { videoUrl: "s3://gen/new.webm", optimizedVideoUrl: "s3://gen/new.mp4" },
            });
            const generation = await harness.db.testGeneration.findUniqueOrThrow({
                where: { id: generationId },
                select: { testPlan: { select: { prompt: true } } },
            });

            // A finding + classification written the old way: the run facts frozen onto the row itself, and here
            // deliberately DIFFERENT from what the generation pins, to prove the stored copies are ignored.
            const finding = await harness.db.analysisFinding.create({
                data: {
                    reportSnapshotId: run.snapshotId,
                    testCaseId,
                    organizationId: run.organizationId,
                    origin: "pre_existing",
                },
                select: { id: true },
            });
            const classification = await harness.db.analysisClassification.create({
                data: {
                    findingId: finding.id,
                    number: 1,
                    generationId,
                    organizationId: run.organizationId,
                    category: "client_bug",
                    headline: "checkout 500s",
                    plan: "a stale frozen plan copy",
                    videoKey: "s3://frozen/video.webm",
                    optimizedVideoKey: "s3://frozen/video.mp4",
                },
                select: { id: true },
            });
            await harness.db.analysisFinding.update({
                where: { id: finding.id },
                data: { currentClassificationId: classification.id },
            });

            const scope = harness.store.forAnalysis(run.snapshotId);
            const [read] = await scope.findings();
            // All three come from the generation the row pins, not the frozen columns.
            expect(read?.current?.plan).toBe(generation.testPlan.prompt);
            expect(read?.current?.videoKey).toBe("s3://gen/new.webm");
            expect(read?.current?.optimizedVideoKey).toBe("s3://gen/new.mp4");
        });

        test("selfHealed is derived correctly for every finding shape", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            await harness.recordVerdict(run, "single", "passed");
            await harness.recordVerdict(run, "healed", "plan_mismatch", { number: 1 });
            await harness.recordVerdict(run, "healed", "passed", { number: 2 });
            const containedId = await harness.findOrCreateTestCase(run, "contained");
            const scope = harness.store.forAnalysis(run.snapshotId);
            await scope.recordContainment({
                testCaseId: containedId,
                failure: { kind: "investigator_crashed", message: "crashed" },
            });

            const findings = await scope.findings();
            const bySlug = new Map(findings.map((finding) => [finding.testCase.slug, finding]));
            expect(bySlug.get("single")?.selfHealed).toBe(false);
            expect(bySlug.get("healed")?.selfHealed).toBe(true);
            expect(bySlug.get("healed")?.current?.category).toBe("passed");
            expect(bySlug.get("contained")?.selfHealed).toBe(false);
        });

        test("refuses to settle while a queued test has neither a verdict nor a containment", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            await harness.recordVerdict(run, "checkout", "passed");
            // A second test queued a run but its Investigator vanished without filing anything.
            const lost = await harness.seedRunForSlug(run, "lost");
            const scope = harness.store.forAnalysis(run.snapshotId);

            await expect(scope.settleReport(harness.settlement())).rejects.toThrow(AnalysisCoverageGapError);
            expect(await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } })).toBeNull();

            // Recording its containment covers the gap: the settlement then goes through.
            await scope.recordContainment({
                testCaseId: lost.testCaseId,
                failure: { kind: "investigator_crashed", message: "crashed" },
            });
            const result = await scope.settleReport(harness.settlement());
            expect(result.settled).toBe(true);
            const report = await harness.db.analysisReport.findUniqueOrThrow({
                where: { snapshotId: run.snapshotId },
            });
            // The contained test counts as an engine_artifact coverage gap, so the report owns up to the full run.
            expect(report.testCount).toBe(2);
            expect(report.coverage).toEqual({ byCategory: [{ category: "engine_artifact", count: 1 }], total: 1 });
        });

        test("N Investigators writing their own rows in parallel lose nothing, and exactly one settlement wins", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            const slugs = ["a", "b", "c", "d", "e"];
            await Promise.all(slugs.map((slug) => harness.recordVerdict(run, slug, "passed")));

            const findings = await harness.db.analysisFinding.findMany({
                where: { reportSnapshotId: run.snapshotId },
                include: { currentClassification: true },
            });
            expect(findings).toHaveLength(slugs.length);
            for (const finding of findings) {
                expect(finding.currentClassification?.category).toBe("passed");
            }

            const scope = harness.store.forAnalysis(run.snapshotId);
            const [first, second] = await Promise.all([
                scope.settleReport(harness.settlement()),
                harness.store.forAnalysis(run.snapshotId).settleReport(harness.settlement()),
            ]);
            const settledCount = [first, second].filter((result) => result.settled).length;
            expect(settledCount).toBe(1);
            expect(await harness.db.analysisReport.count({ where: { snapshotId: run.snapshotId } })).toBe(1);

            const closed = await Promise.all([
                scope.close({ kind: "succeeded" }),
                harness.store.forAnalysis(run.snapshotId).close({ kind: "succeeded" }),
            ]);
            expect(closed.filter(Boolean)).toHaveLength(1);
        });

        test("close records the outcome and returns false for the loser", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const scope = harness.store.forAnalysis(run.snapshotId);

            expect(await scope.close({ kind: "failed", reason: "the pipeline crashed" })).toBe(true);
            const job = await harness.db.analysisJob.findUniqueOrThrow({ where: { snapshotId: run.snapshotId } });
            expect(job.status).toBe("failed");
            expect(job.failureReason).toBe("the pipeline crashed");
            expect(job.completedAt).not.toBeNull();

            expect(await scope.close({ kind: "succeeded" })).toBe(false);
            const unchanged = await harness.db.analysisJob.findUniqueOrThrow({
                where: { snapshotId: run.snapshotId },
            });
            expect(unchanged.status).toBe("failed");
        });

        test("recordSelection is born-at-selection: an unjudged finding with its origin and reason and no verdict", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            const scope = harness.store.forAnalysis(run.snapshotId);
            const bySlug = await harness.selectTests(run, ["checkout", "login"]);

            const findings = await scope.findings();
            expect(findings).toHaveLength(2);
            for (const finding of findings) {
                expect(finding.current).toBeUndefined();
                expect(finding.failure).toBeUndefined();
                expect(finding.origin).toBe("pre_existing");
                expect(finding.selectionReason).toBe(`${bySlug.get(finding.testCase.slug)} affected by the diff`);
                expect(finding.classifications).toHaveLength(0);
                expect(finding.selfHealed).toBe(false);
            }
        });

        test("an unjudged selected finding counts toward neither plane", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const scope = harness.store.forAnalysis(run.snapshotId);
            await harness.selectTests(run, ["checkout", "login"]);
            // Only one of the two selected tests actually got judged.
            await harness.recordVerdict(run, "checkout", "passed");

            const plane = await scope.planeSummary();
            expect(plane.testCount).toBe(1);
            expect(plane.passedCount).toBe(1);
            expect(plane.coverage.total).toBe(0);
        });

        test("recording a verdict after selection restates the same finding rather than duplicating it", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            const scope = harness.store.forAnalysis(run.snapshotId);
            await harness.selectTests(run, ["checkout"]);

            // The Investigator's verdict lands on the finding that selection already created.
            await harness.recordVerdict(run, "checkout", "client_bug");

            const findings = await scope.findings();
            expect(findings).toHaveLength(1);
            expect(findings[0]?.current?.category).toBe("client_bug");
            // The facts settled at selection survive the verdict write.
            expect(findings[0]?.origin).toBe("pre_existing");
            expect(findings[0]?.selectionReason).toContain("affected by the diff");
        });

        test("selection followed by a verdict and a containment settles with full coverage", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const scope = harness.store.forAnalysis(run.snapshotId);
            const bySlug = await harness.selectTests(run, ["checkout", "login"]);

            // checkout runs and is judged; login's Investigator crashes and is contained.
            await harness.recordVerdict(run, "checkout", "passed");
            await scope.recordContainment({
                testCaseId: bySlug.get("login") ?? "",
                origin: "pre_existing",
                failure: { kind: "investigator_crashed", message: "crashed" },
            });

            const result = await scope.settleReport(harness.settlement());
            expect(result.settled).toBe(true);
            const report = await harness.db.analysisReport.findUniqueOrThrow({ where: { snapshotId: run.snapshotId } });
            expect(report.testCount).toBe(2);
        });

        test("recordSelection is idempotent and never wipes a verdict already filed", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const scope = harness.store.forAnalysis(run.snapshotId);
            const bySlug = await harness.selectTests(run, ["checkout"]);
            await harness.recordVerdict(run, "checkout", "client_bug");

            // A workflow replay re-runs the impact stage and re-selects the same test.
            await scope.recordSelection([
                { testCaseId: bySlug.get("checkout") ?? "", origin: "pre_existing", selectionReason: "re-selected" },
            ]);

            const findings = await scope.findings();
            expect(findings).toHaveLength(1);
            expect(findings[0]?.current?.category).toBe("client_bug");
        });

        test("recordImpactReasoning persists onto the job and surfaces on the lifecycle mid-run", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            const scope = harness.store.forAnalysis(run.snapshotId);

            await scope.recordImpactReasoning("The diff touches checkout, so its flows were selected.");

            const lifecycle = await scope.lifecycle();
            expect(lifecycle?.impactReasoning).toBe("The diff touches checkout, so its flows were selected.");
            // No report exists yet - the reasoning is legible before the run settles.
            expect(await scope.report()).toBeUndefined();
        });

        test("recordImpactReasoning stores empty reasoning as absent", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const scope = harness.store.forAnalysis(run.snapshotId);

            await scope.recordImpactReasoning("");

            expect((await scope.lifecycle())?.impactReasoning).toBeUndefined();
        });

        test("the settled report reads impact reasoning off the job, falling back to its own column", async ({
            harness,
        }) => {
            // A run whose job carries the reasoning: the job value is what the report reads.
            const fromJob = await harness.seedAnalysis();
            const jobScope = harness.store.forAnalysis(fromJob.snapshotId);
            await harness.recordVerdict(fromJob, "checkout", "passed");
            await jobScope.recordImpactReasoning("reasoning on the job");
            await jobScope.settleReport({ ...harness.settlement(), impactReasoning: "reasoning in the settlement" });
            expect((await jobScope.report())?.impactReasoning).toBe("reasoning on the job");

            // A run whose job never recorded reasoning (a pre-move report): the report's own column is the fallback.
            const fromReport = await harness.seedAnalysis();
            const reportScope = harness.store.forAnalysis(fromReport.snapshotId);
            await harness.recordVerdict(fromReport, "checkout", "passed");
            await reportScope.settleReport({ ...harness.settlement(), impactReasoning: "reasoning in the settlement" });
            expect((await reportScope.report())?.impactReasoning).toBe("reasoning in the settlement");
        });
    },
});
