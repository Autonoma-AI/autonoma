import {
    type AnalysisLifecycleSummary,
    AnalysisStore,
    type CoveredFinding,
    type Finding,
    type Issue,
} from "@autonoma/analysis";
import type { AnalysisJobStatus, Prisma } from "@autonoma/db";
import type { PrismaClient } from "@autonoma/db";
import { InternalError, NotFoundError } from "@autonoma/errors";
import type { StorageProvider } from "@autonoma/storage";
import {
    aggregateSnapshotHealth,
    computeSnapshotHealth,
    countTestsBySnapshot,
    deriveForkPointSnapshotId,
    listExecutedTestsForSnapshot,
    type SnapshotExecutedTest,
    type SnapshotHealthCounts,
    type SuiteChangeSummary,
    tallyExecutedTests,
    TestSuiteStore,
} from "@autonoma/test-suite";
import {
    type AnalysisForPr,
    type AnalysisIssueDetail,
    type AnalysisIssueFindingInstance,
    type AnalysisIssueSummary,
    analysisFindingSortKey,
    type AnalysisFindingView,
    type AnalysisPrCoveredTest,
    type AnalysisPrIssue,
    type AnalysisPrNewerRun,
    type AnalysisReportData,
    type AnalysisRunView,
    type AnalysisTestOrigin,
    analysisTestOriginSchema,
    type AnalysisSnapshotIssueChanges,
    buildAnalysisFindingUrl,
    buildAnalysisIssueUrl,
    buildPrPageUrl,
    type EvidenceManifestEntry,
    extractEvidenceAssetIds,
    type InvestigationFinding,
    type InvestigationRunStep,
    type MainOpenProblem,
    type OverlayPoint,
    type PrimaryScreenshot,
    type PrPipelineStatus,
    type ResolvedEvidenceAsset,
    type ResolvedPrimaryScreenshot,
    type SnapshotReport,
} from "@autonoma/types";
import { z } from "zod";
import { env } from "../../env";
import type { GitHubInstallationService } from "../../github/github-installation.service";
import type { PullRequestCacheService } from "../../github/pull-request-cache.service";
import { Service } from "../service";
import { type AnalysisFindingDetailView, loadAnalysisFindingDetail } from "./analysis-finding-detail";
import { buildAnalysisRunView, loadLatestGenerations } from "./analysis-run";
import { presentCheckpoint } from "./checkpoint-presentation";
import { loadCreatedTests, type SnapshotCreatedTest } from "./created-tests";
import { loadMainOpenProblems } from "./main-open-problems";
import { computePrPipelineStatus } from "./pr-pipeline-status";
import { loadSnapshotReport } from "./snapshot-report";
import { computeTestSuiteChanges, emptyTestSuiteChanges } from "./test-suite-changes";

export type { TestSuiteChangeRow } from "./test-suite-changes";

/** Signed-URL lifetime for a finding's screenshot/video - short, re-signed on every page load. */
const INVESTIGATION_MEDIA_TTL_SECONDS = 60 * 60;

/**
 * Pull requests per page. Matches GitHub's own list, which is the page every reader arrives from - and the number
 * is returned in the response rather than shared as a constant, so the client's pager can never disagree with the
 * window the server actually cut.
 */
const BRANCH_PAGE_SIZE = 25;

/**
 * Ceiling on a branch's checkpoint history. The legacy pull-request overview asks for one
 * `snapshotDetail` per snapshot in this list, so without a bound a pull request that keeps receiving
 * commits fans that read out indefinitely. High enough that no real pull request reaches it.
 */
const MAX_SNAPSHOTS_LISTED = 100;

/**
 * How the pull-request list is ordered: most recently updated first, which is what GitHub's own list does and so
 * what a reader arriving from it expects. `createdAt` breaks the tie so the order is TOTAL - without a tiebreaker
 * rows with equal timestamps order arbitrarily per query, and a row can appear on two pages or on none.
 *
 * Shared, not repeated: every query that pages this list has to cut the same window, or the page's investigation
 * column would describe a different 25 pull requests than the rows beside it.
 */
const PR_LIST_ORDER: Prisma.BranchOrderByWithRelationInput[] = [
    { prInfo: { prUpdatedAt: { sort: "desc", nulls: "last" } } },
    { createdAt: "desc" },
];

/** Fallback suite-change counts for a snapshot the batched summary has no entry for. */
const NO_SUITE_CHANGES: SuiteChangeSummary = { added: 0, removed: 0, updated: 0 };

/**
 * An authoritative snapshot's `AnalysisJob` lifecycle, as the PR page consumes it. Present only for a snapshot
 * the merged pipeline ran (an org running analysis instead of diffs); `null` for a diffs snapshot. Drives the PR
 * page's running-snapshot fallback: while the run is in flight (or failed) there is no `AnalysisReport` yet, so
 * the page shows this status instead of the findings list.
 */
export interface AnalysisJobStatusView {
    status: AnalysisJobStatus;
    failureReason?: string;
    startedAt?: Date;
    completedAt?: Date;
    /** The Impact Analysis stage's selection reasoning, written when that stage completes; absent while it runs. */
    impactReasoning?: string;
}

/**
 * Reconstruct the UI finding shape from the store's detailed finding (media keys are signed separately, on
 * read). Returns undefined for a finding with no classification: either a row between its creation and its
 * first verdict (a single-transaction window), or - permanently - a contained investigation, whose Investigator
 * crashed before judging any run and which carries a `failure` instead. The report's coverage counts include
 * contained findings; this view does not yet render them (they have no run to link).
 */
function detailedToAnalysisFinding(finding: Finding): AnalysisFindingView | undefined {
    const current = finding.current;
    if (current == null) return undefined;
    return {
        id: finding.findingId,
        slug: finding.testCase.slug,
        generationId: current.generationId,
        testCase: finding.testCase,
        origin: parseAnalysisTestOrigin(finding.origin),
        selectionReason: finding.selectionReason,
        selfHealed: finding.selfHealed,
        category: current.category,
        confidence: current.confidence,
        falsePositiveRisk: current.falsePositiveRisk,
        headline: current.headline,
        expectedBehavior: current.expectedBehavior,
        actualBehavior: current.actualBehavior,
        whatHappened: current.whatHappened,
        planMismatchNote: current.planMismatchNote,
        invalidTestNote: current.invalidTestNote,
        observedAppIssues: current.observedAppIssues,
        remediation: current.remediation,
        rootCause: current.rootCause,
        evidence: current.evidence ?? [],
        plan: current.plan,
        runSuccess: current.runSuccess,
        stepCount: current.stepCount,
        runSteps: current.runSteps,
        // Each step's screenshotUrl is still a raw s3:// key here; signFindingMedia signs them on read.
        runTrace: current.runTrace,
        // Stored s3:// keys; signFindingMedia turns these into browser-openable URLs.
        videoUrl: current.videoKey,
        optimizedVideoUrl: current.optimizedVideoKey,
        keyScreenshotUrl: current.screenshotKey,
        error: current.error,
        classifications: finding.classifications.map((classification) => ({
            id: classification.id,
            number: classification.number,
            generationId: classification.generationId,
            category: classification.category,
            headline: classification.headline,
            createdAt: classification.createdAt,
            // Still the raw s3:// key here; signAnalysisFinding signs it alongside the finding's media.
            conversationUrl: classification.conversationUrl,
        })),
        issueId: finding.issue?.id,
        issueTitle: finding.issue?.title,
    };
}

/**
 * `origin` is stored as a plain string (matching the analysis island's column style), so it is parsed at this
 * boundary. An unrecognized value reads as absent - the surfaces that branch on origin fall back rather than
 * mis-bucketing the test.
 */
function parseAnalysisTestOrigin(origin: string | undefined): AnalysisTestOrigin | undefined {
    if (origin == null) return undefined;
    const parsed = analysisTestOriginSchema.safeParse(origin);
    return parsed.success ? parsed.data : undefined;
}

/**
 * The distinct tests an issue covers, each carrying the verdict and Impact Analysis reasoning from the most recent
 * run that attributed it - one finding exists per (run, test), so the newest run's row is the current story for that
 * test. Slug-ordered so the list is stable across requests.
 */
function coveredTestsForIssue(issue: Issue): AnalysisPrCoveredTest[] {
    const newestByTest = new Map<string, CoveredFinding>();
    for (const finding of issue.coveredFindings) {
        const seen = newestByTest.get(finding.testCaseId);
        if (seen == null || finding.snapshotCreatedAt > seen.snapshotCreatedAt) {
            newestByTest.set(finding.testCaseId, finding);
        }
    }
    return [...newestByTest.values()]
        .map((finding) => ({
            slug: finding.slug,
            origin: parseAnalysisTestOrigin(finding.origin),
            selectionReason: finding.selectionReason,
            category: finding.category ?? "",
        }))
        .sort((left, right) => left.slug.localeCompare(right.slug));
}

/**
 * The caveat to attach when a run NEWER than the reported one exists but has produced no report of its own: `running`
 * warns the reader the issue set may shift, `failed` tells them the newest attempt did not land, so what they are
 * reading describes the previous run. A newer job that completed without a report should not happen (the Reporter
 * writes one before finalize), so it carries no caveat rather than inventing a failure.
 *
 * Newness is compared by snapshot time, so a report whose own snapshot has no job row cannot make an OLDER job read
 * as a newer run.
 */
function newerRunFrom(
    latest: { status: AnalysisJobStatus; failureReason?: string; snapshotCreatedAt: Date },
    reportedRunAt: Date,
): AnalysisPrNewerRun | undefined {
    if (latest.snapshotCreatedAt <= reportedRunAt) return undefined;
    if (latest.status === "running") return { status: "running" };
    if (latest.status === "failed") {
        return { status: "failed", failureReason: latest.failureReason };
    }
    return undefined;
}

export class BranchesService extends Service {
    private readonly analysisStore: AnalysisStore;
    private readonly suite: TestSuiteStore;

    constructor(
        private readonly db: PrismaClient,
        private readonly github: GitHubInstallationService,
        private readonly storageProvider: StorageProvider,
        private readonly prCache: PullRequestCacheService,
    ) {
        super();
        this.analysisStore = new AnalysisStore(db);
        this.suite = new TestSuiteStore(db);
    }

    /**
     * The authoritative analysis report for the snapshot page: the merged pipeline's per-run `AnalysisReport`
     * header (the Reporter's prose + summary, the run counts, the impact reasoning) plus its `AnalysisFinding`
     * children, each re-signed into browser-openable media URLs. Reads keyed 1:1 by snapshot (the report's primary
     * key), org-scoped.
     *
     * Returns `null`, never `undefined`, for absence: this is the page-level gate (a snapshot with a report gets
     * the authoritative layout, otherwise the diffs UI is left untouched), consumed by a React Query query whose
     * queryFn must not resolve to `undefined`. Degrades to `null` on any failure so a transient DB error never
     * crashes the snapshot page - it just falls back to the diffs layout.
     */
    async getAnalysisReportData(snapshotId: string, organizationId: string): Promise<AnalysisReportData | null> {
        this.logger.info("Getting analysis report data", { extra: { snapshotId } });
        try {
            // The lifecycle is the org-scoped gate: a snapshot outside the organization (or never analyzed) is
            // absent from the map, so the unscoped per-snapshot reads below are only reached for one we own.
            const lifecycle = (await this.analysisStore.lifecycles([snapshotId], { organizationId })).get(snapshotId);
            if (lifecycle == null) return null;

            const analysis = this.analysisStore.forAnalysis(snapshotId);
            // The report exists only once the Reporter settled; absence => still running or failed, and the page
            // polls the lifecycle-status fallback. Checked first so a still-running poll never fetches findings.
            const report = await analysis.report();

            if (report == null) return null;

            const detailed = await analysis.findings();
            const views = detailed.flatMap((finding) => {
                const view = detailedToAnalysisFinding(finding);
                return view != null ? [view] : [];
            });
            // Stable sort over the store's slug order, so findings stay slug-ordered within their bucket.
            const sorted = views.sort(
                (left, right) => analysisFindingSortKey(left.category) - analysisFindingSortKey(right.category),
            );
            const [findings, reportEvidence, run, verdict] = await Promise.all([
                Promise.all(sorted.map((finding) => this.signAnalysisFinding(finding))),
                this.signEvidenceManifest(report.reportMarkdown, report.evidenceManifest),
                analysis.planeSummary(),
                this.analysisStore.forBranch(report.branchId).verdict(),
            ]);
            this.logger.info("Analysis report data assembled", {
                extra: { snapshotId, findingCount: findings.length, reportEvidenceCount: reportEvidence.length },
            });
            return {
                branchId: report.branchId,
                impactReasoning: report.impactReasoning,
                reportMarkdown: report.reportMarkdown ?? "",
                // Unauthored title is absent from the store; the wire keeps the "" the UI's `analysisPrTitle`
                // already reads as unauthored.
                title: report.title ?? "",
                headline: report.headline ?? "",
                flows: report.flows,
                reportEvidence,
                run,
                verdict,
                findings,
            };
        } catch (error) {
            this.logger.warn("Could not load analysis report data; treating as absent", {
                extra: { snapshotId },
                err: error,
            });
            return null;
        }
    }

    /**
     * The authoritative `AnalysisJob` lifecycle for a snapshot: the merged pipeline's own status row.
     * Returns `null` for a diffs snapshot (no `AnalysisJob`), so the PR page can tell an authoritative
     * snapshot apart from a diffs one even before any `AnalysisReport` exists - the running-snapshot fallback reads
     * this to show the run's status while findings are still being produced. Org-scoped, keyed 1:1 by snapshot.
     *
     * Degrades to `null` on any failure, like `getAnalysisReportData`: this is the PR page's gate query (the whole
     * layout branches on it), so a transient DB error must fall back to the diffs layout, never crash the page.
     */
    async getAnalysisJobStatus(snapshotId: string, organizationId: string): Promise<AnalysisJobStatusView | null> {
        this.logger.info("Getting analysis job status", { extra: { snapshotId } });
        try {
            const lifecycle = (await this.analysisStore.lifecycles([snapshotId], { organizationId })).get(snapshotId);
            if (lifecycle == null) {
                this.logger.info("No analysis job for snapshot; treating as a diffs snapshot", {
                    extra: { snapshotId },
                });
                return null;
            }
            return {
                status: lifecycle.status,
                failureReason: lifecycle.failureReason,
                startedAt: lifecycle.startedAt,
                completedAt: lifecycle.completedAt,
                impactReasoning: lifecycle.impactReasoning,
            };
        } catch (error) {
            this.logger.warn("Could not load analysis job status; treating as absent", {
                extra: { snapshotId },
                err: error,
            });
            return null;
        }
    }

    /**
     * The run's findings with each test's latest generation status, plus the selection summary. Unlike
     * {@link getAnalysisReportData} it does not wait for the Reporter to settle, so it has data mid-run. `null` for
     * a diffs snapshot, and degrades to `null` on any failure like the other analysis reads. Org-scoped.
     */
    async getAnalysisRun(snapshotId: string, organizationId: string): Promise<AnalysisRunView | null> {
        this.logger.info("Getting analysis run", { extra: { snapshotId } });
        try {
            const lifecycle = (await this.analysisStore.lifecycles([snapshotId], { organizationId })).get(snapshotId);
            if (lifecycle == null) return null;

            const findings = await this.analysisStore.forAnalysis(snapshotId).findings();
            const [generations, suiteChanges] = await Promise.all([
                loadLatestGenerations(
                    this.db,
                    snapshotId,
                    findings.map((finding) => finding.testCase.id),
                ),
                this.suite.changesSince(snapshotId),
            ]);
            const view = buildAnalysisRunView(findings, generations, suiteChanges);
            this.logger.info("Analysis run assembled", {
                extra: { snapshotId, findingCount: view.findings.length },
            });
            return view;
        } catch (error) {
            this.logger.warn("Could not load analysis run; treating as absent", {
                extra: { snapshotId },
                err: error,
            });
            return null;
        }
    }

    /**
     * One finding in full for the checkpoint drawer: identity, iteration history, the selected iteration's
     * verdict story, the generation behind it (live steps included), and the plan with the PR's change to it.
     * Served mid-run - a queued or running test answers with whatever exists so far. Org-scoped; `null` for an
     * unknown/foreign finding or an unknown iteration, and degrades to `null` on any failure like the other
     * analysis reads.
     */
    async getAnalysisFindingDetail(
        findingId: string,
        organizationId: string,
        options: { iteration?: number; isAdmin: boolean },
    ): Promise<AnalysisFindingDetailView | null> {
        this.logger.info("Getting analysis finding detail", {
            extra: { findingId, iteration: options.iteration },
        });
        try {
            const view = await loadAnalysisFindingDetail(
                {
                    db: this.db,
                    storage: this.storageProvider,
                    suite: this.suite,
                    analysisStore: this.analysisStore,
                    logger: this.logger,
                },
                {
                    findingId,
                    organizationId,
                    iteration: options.iteration,
                    isAdmin: options.isAdmin,
                },
            );
            if (view == null) return null;
            this.logger.info("Analysis finding detail assembled", {
                extra: { findingId, stepCount: view.generation?.steps.length ?? 0 },
            });
            return view;
        } catch (error) {
            this.logger.warn("Could not load analysis finding detail; treating as absent", {
                extra: { findingId },
                err: error,
            });
            return null;
        }
    }

    /**
     * The branch's analysis issues (all statuses), for the PR page. The page shows only the OPEN ones in the
     * issues-first list, but returns resolved issues too so the report prose's `issue:<id>` tokens can link a
     * resolved issue (e.g. "resolved [X](issue:...) this checkpoint") instead of treating it as fabricated - the
     * issue-detail page renders resolved issues fully. Issues are branch-scoped (they evolve across snapshots), so
     * this reads by branch, not snapshot. Malformed rows (a kind/severity/status that fails to parse) are skipped.
     * Ordered by the ledger, bugs-first then by descending severity. Degrades to an empty list on any failure
     * (never crashes the PR overview).
     */
    async getAnalysisIssues(branchId: string, organizationId: string): Promise<AnalysisIssueSummary[]> {
        this.logger.info("Getting analysis issues", { extra: { branchId } });
        try {
            const branch = await this.db.branch.findFirst({
                where: { id: branchId, organizationId },
                select: { id: true },
            });
            if (branch == null) return [];
            const issues = await this.analysisStore.forBranch(branchId).issues();
            const summaries = await this.toIssueSummaries(issues);
            this.logger.info("Analysis issues assembled", { extra: { branchId, count: summaries.length } });
            return summaries;
        } catch (error) {
            this.logger.warn("Could not load analysis issues; treating as empty", {
                extra: { branchId },
                err: error,
            });
            return [];
        }
    }

    /**
     * The open issues on the application's main branch, bugs-first then by descending severity - the one read
     * behind the overview rail and the main-branch page's problem list.
     */
    async getMainOpenProblems(applicationId: string, organizationId: string): Promise<MainOpenProblem[]> {
        return await loadMainOpenProblems(this.db, applicationId, organizationId, this.logger);
    }

    /**
     * One analysis issue in full, for the PR-level issue-detail page: the header, the grounded narrative with its
     * signed evidence / hero / suspected cause, and every finding instance the issue covers across the branch's
     * snapshots (newest first, each linking to its per-snapshot finding page). Org-scoped. Returns `null` for an
     * unknown or malformed issue, and degrades to `null` on any failure - the page renders a graceful not-found.
     */
    async getAnalysisIssueDetail(issueId: string, organizationId: string): Promise<AnalysisIssueDetail | null> {
        this.logger.info("Getting analysis issue detail", { extra: { issueId } });
        try {
            const issue = await this.analysisStore.issue(issueId, { organizationId });
            if (issue == null) return null;

            const [evidence, primaryScreenshot] = await Promise.all([
                this.signEvidenceManifest(issue.narrativeMarkdown, issue.evidenceManifest),
                issue.primaryScreenshot != null
                    ? this.signPrimaryScreenshot(issue.primaryScreenshot)
                    : Promise.resolve(undefined),
            ]);

            const findingInstances = this.toIssueFindingInstances(issue.coveredFindings);
            this.logger.info("Analysis issue detail assembled", {
                extra: { issueId, instanceCount: findingInstances.length, evidenceCount: evidence.length },
            });
            return {
                id: issue.id,
                title: issue.title,
                kind: issue.kind,
                severity: issue.severity,
                status: issue.status,
                expectedBehavior: issue.expectedBehavior,
                actualBehavior: issue.actualBehavior,
                narrativeMarkdown: issue.narrativeMarkdown,
                evidence,
                suspectedCause: issue.suspectedCause,
                primaryScreenshot,
                resolvedAt: issue.resolvedAt,
                findingInstances,
            };
        } catch (error) {
            this.logger.warn("Could not load analysis issue detail; treating as absent", {
                extra: { issueId },
                err: error,
            });
            return null;
        }
    }

    /**
     * The per-job issue-set changes for a snapshot's analysis run: which branch issues the run OPENED, CARRIED
     * FORWARD from an earlier run, or RESOLVED. Derived from the run's `AnalysisJob` window: an issue attributed
     * to one of this snapshot's findings was opened this run if it was created during the job window, else carried
     * forward; a resolved issue whose `resolvedAt` falls in the window was resolved this run. Returns empty groups
     * for a diffs snapshot (no `AnalysisJob`) and degrades to empty on any failure.
     */
    async getAnalysisSnapshotIssueChanges(
        snapshotId: string,
        organizationId: string,
    ): Promise<AnalysisSnapshotIssueChanges> {
        this.logger.info("Getting analysis snapshot issue changes", { extra: { snapshotId } });
        const empty: AnalysisSnapshotIssueChanges = { opened: [], carriedForward: [], resolved: [] };
        try {
            const lifecycle = (await this.analysisStore.lifecycles([snapshotId], { organizationId })).get(snapshotId);
            if (lifecycle == null) return empty;

            const changes = await this.analysisStore.forAnalysis(snapshotId).issueChanges();
            const [opened, carriedForward, resolved] = await Promise.all([
                this.toIssueSummaries(changes.opened),
                this.toIssueSummaries(changes.carriedForward),
                this.toIssueSummaries(changes.resolved),
            ]);
            this.logger.info("Analysis snapshot issue changes assembled", {
                extra: {
                    snapshotId,
                    opened: opened.length,
                    carriedForward: carriedForward.length,
                    resolved: resolved.length,
                },
            });
            return { opened, carriedForward, resolved };
        } catch (error) {
            this.logger.warn("Could not load analysis snapshot issue changes; treating as empty", {
                extra: { snapshotId },
                err: error,
            });
            return empty;
        }
    }

    /**
     * The analysis of one pull request, resolved from `applicationId + prNumber` rather than a snapshot id. Backs the
     * MCP `get_analysis` tool, so a coding agent can read what the run found - and fix it - with no in-app login.
     *
     * The two grains it joins are deliberate. The run HEADER (verdict, prose, coverage, counts) comes from the
     * branch's newest `AnalysisReport`, which is per-snapshot. The ISSUES come from the BRANCH and are read LIVE,
     * because that is the question a reader actually has ("what is still broken on this PR?") and because an issue is
     * stable across pushes while a finding is not. A consequence worth knowing: between a new run starting and its
     * comment being replaced, this is MORE current than the PR comment, which renders once per run.
     *
     * Unlike the page-facing reads, a query failure here is NOT degraded to an empty result: reporting "no analysis"
     * when the truth is "the read failed" would have an agent tell a developer their PR is clean. It logs and
     * rethrows so the caller surfaces an error instead.
     */
    async getAnalysisForPr(applicationId: string, prNumber: number, organizationId: string): Promise<AnalysisForPr> {
        this.logger.info("Getting analysis for PR", { applicationId, prNumber });
        try {
            const branch = await this.db.branch.findFirst({
                where: { applicationId, prInfo: { prNumber }, application: { organizationId } },
                select: { id: true, application: { select: { slug: true } } },
            });
            if (branch == null) {
                this.logger.info("No tracked branch for PR; no analysis to report", { applicationId, prNumber });
                return { status: "no_analysis" };
            }

            const ledger = this.analysisStore.forBranch(branch.id);
            // The lifecycle answers "is a run going" even when a report exists, so it is read alongside rather
            // than derived from one.
            const [verdict, report, latestLifecycle, issueRows] = await Promise.all([
                ledger.verdict(),
                ledger.latestReport(),
                ledger.latestLifecycle(),
                ledger.openIssues(),
            ]);

            // No lifecycle at all means this PR was never analyzed by this pipeline - distinct from a run that
            // produced nothing, so the caller can point the reader somewhere else instead of claiming a clean PR.
            if (latestLifecycle == null) {
                this.logger.info("No analysis job for PR", { applicationId, prNumber });
                return { status: "no_analysis" };
            }
            if (report == null) {
                if (latestLifecycle.status === "failed") {
                    this.logger.info("Analysis run failed before producing a report", { applicationId, prNumber });
                    return { status: "failed", failureReason: latestLifecycle.failureReason };
                }
                this.logger.info("Analysis run has not produced a report yet", { applicationId, prNumber });
                return { status: "in_progress" };
            }

            const appSlug = branch.application.slug;
            const [issues, reportEvidence, latestRun] = await Promise.all([
                this.toPrIssues(issueRows, appSlug, prNumber),
                this.signEvidenceManifest(report.reportMarkdown, report.evidenceManifest),
                this.analysisStore.forAnalysis(report.snapshotId).planeSummary(),
            ]);

            this.logger.info("Analysis for PR assembled", {
                applicationId,
                prNumber,
                extra: { snapshotId: report.snapshotId, issueCount: issues.length },
            });
            return {
                status: "complete",
                verdict,
                title: report.title ?? "",
                headline: report.headline ?? "",
                flows: report.flows,
                reportMarkdown: report.reportMarkdown,
                reportEvidence,
                coverage: latestRun.coverage,
                impactReasoning: report.impactReasoning,
                prUrl: buildPrPageUrl(env.APP_URL, appSlug, prNumber),
                issues,
                newerRun: newerRunFrom(latestLifecycle, report.snapshotCreatedAt),
            };
        } catch (error) {
            this.logger.warn("Could not load analysis for PR", { applicationId, prNumber, err: error });
            throw error;
        }
    }

    /** Degrades to an empty map: the rail must still render when the analysis tables are unreachable. */
    private async loadLifecycles(
        snapshotIds: string[],
        organizationId: string,
    ): Promise<Map<string, AnalysisLifecycleSummary>> {
        try {
            return await this.analysisStore.lifecycles(snapshotIds, { organizationId });
        } catch (error) {
            this.logger.warn("Could not load analysis lifecycles; presenting the snapshots as unanalyzed", {
                extra: { count: snapshotIds.length },
                err: error,
            });
            return new Map();
        }
    }

    private async toPrIssues(issues: Issue[], appSlug: string, prNumber: number): Promise<AnalysisPrIssue[]> {
        return Promise.all(issues.map((issue) => this.toPrIssue(issue, appSlug, prNumber)));
    }

    /**
     * One open issue as an API consumer reads it: the behavior claim, the grounded cause, signed media, and the two
     * links that mean different things - the branch-scoped ISSUE (the cross-snapshot case) and the specific RUN that
     * reproduces it. The ledger already validated the row.
     */
    private async toPrIssue(issue: Issue, appSlug: string, prNumber: number): Promise<AnalysisPrIssue> {
        const designated = issue.designatedRun;
        const [screenshotUrl, clipUrl] = await Promise.all([
            issue.primaryScreenshot != null ? this.signMediaUrl(issue.primaryScreenshot.s3Key) : undefined,
            designated?.clipKey != null ? this.signMediaUrl(designated.clipKey) : undefined,
        ]);

        return {
            id: issue.id,
            title: issue.title,
            kind: issue.kind,
            severity: issue.severity,
            expectedBehavior: issue.expectedBehavior,
            actualBehavior: issue.actualBehavior,
            suspectedCause: issue.suspectedCause,
            screenshotUrl,
            clipUrl,
            // Distinct snapshots, not finding rows: one run can attribute several findings to the same issue.
            runCount: new Set(issue.coveredFindings.map((finding) => finding.snapshotId)).size,
            issueUrl: buildAnalysisIssueUrl(env.APP_URL, appSlug, prNumber, issue.id),
            // Unlike the PR comment (which only offers a replay when there is a clip to watch), the run link is worth
            // returning whenever a reproduction was designated - a reader here can inspect the run itself.
            replayUrl:
                designated != null
                    ? buildAnalysisFindingUrl(
                          env.APP_URL,
                          appSlug,
                          prNumber,
                          designated.snapshotId,
                          designated.findingId,
                      )
                    : undefined,
            coveredTests: coveredTestsForIssue(issue),
        };
    }

    /** Sign one stored media key into a short-lived URL; a signing failure drops the media, never the issue. */
    private async signMediaUrl(s3Key: string): Promise<string | undefined> {
        try {
            return await this.storageProvider.getSignedUrl(s3Key, INVESTIGATION_MEDIA_TTL_SECONDS);
        } catch (error) {
            this.logger.warn("Failed to sign analysis media", { extra: { s3Key }, err: error });
            return undefined;
        }
    }

    /**
     * Re-sign an analysis finding: its current classification's media, plus every iteration's classifier
     * conversation, so the self-heal history's debug links are browser-openable rather than `s3://` keys.
     */
    private async signAnalysisFinding(finding: AnalysisFindingView): Promise<AnalysisFindingView> {
        const [signed, classifications] = await Promise.all([
            this.signFindingMedia(finding),
            Promise.all(
                finding.classifications.map(async (classification) => ({
                    ...classification,
                    conversationUrl:
                        classification.conversationUrl != null
                            ? await this.storageProvider.getSignedUrl(
                                  classification.conversationUrl,
                                  INVESTIGATION_MEDIA_TTL_SECONDS,
                              )
                            : undefined,
                })),
            ),
        ]);
        return { ...signed, classifications };
    }

    /** Re-sign a finding's stored s3:// screenshot/video keys (finding media + every run-trace step) into URLs. */
    private async signFindingMedia<T extends InvestigationFinding>(finding: T): Promise<T> {
        const sign = (key: string | undefined) =>
            key != null ? this.storageProvider.getSignedUrl(key, INVESTIGATION_MEDIA_TTL_SECONDS) : undefined;
        const [keyScreenshotUrl, videoUrl, optimizedVideoUrl, runTrace] = await Promise.all([
            sign(finding.keyScreenshotUrl),
            sign(finding.videoUrl),
            sign(finding.optimizedVideoUrl),
            finding.runTrace != null ? Promise.all(finding.runTrace.map((step) => this.signStep(step))) : undefined,
        ]);
        return { ...finding, keyScreenshotUrl, videoUrl, optimizedVideoUrl, runTrace };
    }

    /** Sign one run-trace step's stored screenshot key; the coordinates and labels pass through untouched. */
    private async signStep(step: InvestigationRunStep): Promise<InvestigationRunStep> {
        const screenshotUrl =
            step.screenshotUrl != null
                ? await this.storageProvider.getSignedUrl(step.screenshotUrl, INVESTIGATION_MEDIA_TTL_SECONDS)
                : undefined;
        return { ...step, screenshotUrl };
    }

    private async toIssueSummaries(issues: Issue[]): Promise<AnalysisIssueSummary[]> {
        const summaries = await Promise.all(issues.map((issue) => this.toIssueSummary(issue)));
        return summaries;
    }

    private async toIssueSummary(issue: Issue): Promise<AnalysisIssueSummary> {
        const thumbnailUrl = await this.signIssueThumbnail(issue.primaryScreenshot);
        // Distinct snapshots, not finding rows: one run can attribute several findings to the same issue.
        const runCount = new Set(issue.coveredFindings.map((finding) => finding.snapshotId)).size;
        return {
            id: issue.id,
            title: issue.title,
            kind: issue.kind,
            severity: issue.severity,
            status: issue.status,
            thumbnailUrl,
            runCount,
        };
    }

    /**
     * Flatten an issue's covered findings into cross-snapshot instances, newest snapshot first. Each instance
     * shows the verdict its run stands behind, so a finding still mid-run (no classification yet) is skipped
     * rather than listed with nothing to say.
     */
    private toIssueFindingInstances(findings: CoveredFinding[]): AnalysisIssueFindingInstance[] {
        return findings
            .flatMap((finding) => {
                if (finding.category == null || finding.headline == null) return [];
                return [
                    {
                        snapshotId: finding.snapshotId,
                        snapshotCreatedAt: finding.snapshotCreatedAt,
                        headSha: finding.headSha,
                        findingId: finding.findingId,
                        slug: finding.slug,
                        category: finding.category,
                        headline: finding.headline,
                    },
                ];
            })
            .sort((a, b) => b.snapshotCreatedAt.getTime() - a.snapshotCreatedAt.getTime());
    }

    /**
     * Sign the evidence-manifest assets a narrative actually references (by `evidence:<assetId>` token) into
     * short-lived URLs. Only referenced assets are resolved (the narrative is the source of truth for what
     * renders), and an asset whose key cannot be signed drops out - so its token renders as nothing, never a
     * broken image. Mirrors the bug-detail evidence resolution.
     */
    private async signEvidenceManifest(
        narrativeMarkdown: string | undefined,
        manifest: EvidenceManifestEntry[],
    ): Promise<ResolvedEvidenceAsset[]> {
        if (narrativeMarkdown == null) return [];
        const referencedIds = new Set(extractEvidenceAssetIds(narrativeMarkdown));
        const referenced = manifest.filter((asset) => referencedIds.has(asset.assetId));
        const resolved = await Promise.all(
            referenced.map(async (asset): Promise<ResolvedEvidenceAsset | undefined> => {
                try {
                    const url = await this.storageProvider.getSignedUrl(asset.s3Key, INVESTIGATION_MEDIA_TTL_SECONDS);
                    return { assetId: asset.assetId, url, kind: asset.kind, pin: asset.pin };
                } catch (error) {
                    this.logger.warn("Failed to sign evidence asset; its token will render as nothing", {
                        extra: { assetId: asset.assetId },
                        err: error,
                    });
                    return undefined;
                }
            }),
        );
        return resolved.filter((asset): asset is ResolvedEvidenceAsset => asset != null);
    }

    /** Sign an issue's designated primary screenshot into a hero (URL + click pin); undefined if it can't sign. */
    private async signPrimaryScreenshot(primary: PrimaryScreenshot): Promise<ResolvedPrimaryScreenshot | undefined> {
        try {
            const url = await this.storageProvider.getSignedUrl(primary.s3Key, INVESTIGATION_MEDIA_TTL_SECONDS);
            const points: OverlayPoint[] =
                primary.pin != null ? [{ x: primary.pin.x, y: primary.pin.y, role: "click" }] : [];
            return { url, points };
        } catch (error) {
            this.logger.warn("Failed to sign issue primary screenshot", {
                extra: { s3Key: primary.s3Key },
                err: error,
            });
            return undefined;
        }
    }

    /** Sign an issue's primary screenshot into a bare thumbnail URL for the list card; undefined when absent. */
    private async signIssueThumbnail(primary: PrimaryScreenshot | undefined): Promise<string | undefined> {
        if (primary == null) return undefined;
        const signed = await this.signPrimaryScreenshot(primary);
        return signed?.url;
    }

    /**
     * Every open branch's name and test count, for the Tests page's branch picker.
     *
     * Deliberately NOT `listBranches`: the picker needs two fields and has no search box, so paging it would
     * silently hide older branches with no way to reach them, while the full list's per-row health aggregates are
     * work the picker throws away. This is two cheap queries with no fan-out, so it can stay unpaged.
     */
    async listBranchNames(applicationId: string, organizationId: string) {
        this.logger.info("Listing branch names", { applicationId });

        const branches = await this.db.branch.findMany({
            where: { applicationId, prInfo: prInfoStateFilter("open"), application: { organizationId } },
            select: { id: true, name: true, activeSnapshotId: true },
            orderBy: PR_LIST_ORDER,
        });

        const testCountBySnapshot = await countTestsBySnapshot(
            this.db,
            branches.map((branch) => branch.activeSnapshotId).filter((id): id is string => id != null),
        );

        return branches.map((branch) => ({
            id: branch.id,
            name: branch.name,
            testCount: branch.activeSnapshotId != null ? (testCountBySnapshot.get(branch.activeSnapshotId) ?? 0) : 0,
        }));
    }

    /**
     * One page of an application's pull requests, most recently updated first.
     *
     * Paged rather than whole because every aggregate below fans out over the rows this returns: an application
     * with ~300 open pull requests spent seconds building a list nobody scrolls. A page bounds all of it at once.
     */
    async listBranches(
        applicationId: string,
        organizationId: string,
        state: PullRequestStateFilter = "open",
        page = 1,
    ) {
        this.logger.info("Listing branches", { applicationId, extra: { state, page } });

        const where = { applicationId, prInfo: prInfoStateFilter(state), application: { organizationId } };

        // Clamped, not trusted: `?page=12` outlives the twelfth page (pull requests merge, the list shrinks, a
        // bookmark goes stale). Serving the last page beats an empty table under a pager offering pages that no
        // longer exist. The page actually served comes back in the response, and every other surface follows it.
        const totalCount = await this.db.branch.count({ where });
        const pageCount = Math.max(1, Math.ceil(totalCount / BRANCH_PAGE_SIZE));
        const effectivePage = Math.min(Math.max(page, 1), pageCount);

        const branches = await this.db.branch.findMany({
            where,
            select: {
                id: true,
                name: true,
                createdAt: true,
                prInfo: {
                    select: {
                        prNumber: true,
                        prTitle: true,
                        prState: true,
                        prAuthorLogin: true,
                        prUpdatedAt: true,
                    },
                },
                activeSnapshot: { select: { id: true, status: true, headSha: true } },
            },
            orderBy: PR_LIST_ORDER,
            skip: (effectivePage - 1) * BRANCH_PAGE_SIZE,
            take: BRANCH_PAGE_SIZE,
        });

        const activeSnapshots = branches
            .map((b) => b.activeSnapshot)
            .filter((s): s is NonNullable<typeof s> => s != null)
            .map((s) => ({ id: s.id, status: s.status }));

        const [healthBySnapshot, lifecycleBySnapshot, previewUrlByPr, previewStateByPr, latestRunByBranch] =
            await Promise.all([
                aggregateSnapshotHealth(this.db, activeSnapshots, this.logger),
                this.loadLifecycles(
                    activeSnapshots.map((s) => s.id),
                    organizationId,
                ),
                this.loadPreviewUrlsByPr(
                    applicationId,
                    organizationId,
                    branches.map((b) => ({ branchId: b.id, prNumber: b.prInfo!.prNumber })),
                ),
                this.loadPreviewStateByPr(
                    applicationId,
                    organizationId,
                    branches.map((b) => b.prInfo!.prNumber),
                ),
                this.loadLatestRunByBranch(branches.map((b) => b.id)),
            ]);

        // Best-effort, fire-and-forget refresh of the cached PR metadata. Throttled in
        // Postgres, so this no-ops when the cache is fresh and never blocks the response.
        this.prCache.kickOff(applicationId, organizationId);

        const items = branches.map(({ prInfo, activeSnapshot, ...branch }) => {
            const checkpoint =
                activeSnapshot != null
                    ? presentCheckpoint({
                          lifecycle: lifecycleBySnapshot.get(activeSnapshot.id),
                          healthResult: healthBySnapshot.get(activeSnapshot.id),
                      })
                    : undefined;
            const summary = checkpoint?.summary;
            const health = checkpoint?.health ?? "unknown";

            const prStatus = computePrPipelineStatus({
                activeSnapshot:
                    activeSnapshot != null ? { headSha: activeSnapshot.headSha ?? undefined, summary } : undefined,
                latestRun: latestRunByBranch.get(branch.id),
                previewEnv: previewStateByPr.get(prInfo!.prNumber),
            });

            return {
                ...branch,
                prNumber: prInfo!.prNumber,
                pr: {
                    title: prInfo!.prTitle ?? undefined,
                    state: prInfo!.prState ?? undefined,
                    authorLogin: prInfo!.prAuthorLogin ?? undefined,
                    updatedAt: prInfo!.prUpdatedAt ?? undefined,
                },
                previewUrl: previewUrlByPr.get(prInfo!.prNumber),
                prStatus,
                activeSnapshot:
                    activeSnapshot != null
                        ? {
                              id: activeSnapshot.id,
                              status: activeSnapshot.status,
                              _count: {
                                  testCaseAssignments: healthBySnapshot.get(activeSnapshot.id)?.counts.totalTests ?? 0,
                              },
                              health,
                              summary,
                          }
                        : null,
            };
        });

        return { items, totalCount, page: effectivePage, pageSize: BRANCH_PAGE_SIZE };
    }

    /**
     * Bulk-resolves a preview URL per PR number for an application, so the Home PR
     * list can show a clickable preview link without an N+1 fanout. Mirrors the
     * per-PR preview summary: prefer a Previewkit environment URL (any status with a
     * URL except failed / torn_down), then fall back to the legacy branch webDeployment
     * URL. Returns a map of prNumber -> URL.
     */
    private async loadPreviewUrlsByPr(
        applicationId: string,
        organizationId: string,
        branches: Array<{ branchId: string; prNumber: number }>,
    ): Promise<Map<number, string>> {
        if (branches.length === 0) return new Map();

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });
        const githubRepositoryId = application?.githubRepositoryId;

        const [previewkitEnvironments, legacyDeployments] = await Promise.all([
            githubRepositoryId != null
                ? this.db.previewkitEnvironment.findMany({
                      where: {
                          organizationId,
                          githubRepositoryId,
                          prNumber: { in: branches.map((b) => b.prNumber) },
                          status: { notIn: ["torn_down", "failed"] },
                      },
                      select: { prNumber: true, urls: true },
                      orderBy: { updatedAt: "desc" },
                  })
                : Promise.resolve([]),
            this.db.branchDeployment.findMany({
                where: {
                    organizationId,
                    branchId: { in: branches.map((b) => b.branchId) },
                    webDeployment: { isNot: null },
                },
                select: { branchId: true, webDeployment: { select: { url: true } } },
                orderBy: { updatedAt: "desc" },
            }),
        ]);

        const previewkitUrlByPr = new Map<number, string>();
        for (const environment of previewkitEnvironments) {
            if (previewkitUrlByPr.has(environment.prNumber)) continue;
            const url = firstPreviewUrl(environment.urls);
            if (url != null) previewkitUrlByPr.set(environment.prNumber, url);
        }

        const legacyUrlByBranch = new Map<string, string>();
        for (const deployment of legacyDeployments) {
            if (legacyUrlByBranch.has(deployment.branchId)) continue;
            const url = deployment.webDeployment?.url;
            if (url != null && url !== "") legacyUrlByBranch.set(deployment.branchId, url);
        }

        const urlByPr = new Map<number, string>();
        for (const branch of branches) {
            const url = previewkitUrlByPr.get(branch.prNumber) ?? legacyUrlByBranch.get(branch.branchId);
            if (url != null) urlByPr.set(branch.prNumber, url);
        }
        return urlByPr;
    }

    /**
     * Bulk-resolves each PR's current preview-environment state (status + deployed commit) for an
     * application, so the PR list can roll every branch into its pipeline status without an N+1 fanout.
     * Resolved by (repository, PR number), not the `branch_id` FK: that FK is only sparsely backfilled,
     * so a PR-number join is what reliably reaches a branch's live environment today. Torn-down
     * environments are excluded, and the most-recently-updated row wins when a PR number was reused
     * (branch deleted then recreated). Returns a map of prNumber -> preview state.
     */
    private async loadPreviewStateByPr(
        applicationId: string,
        organizationId: string,
        prNumbers: number[],
    ): Promise<Map<number, { status: string; headSha: string; appStatuses: string[] }>> {
        if (prNumbers.length === 0) return new Map();

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });
        const githubRepositoryId = application?.githubRepositoryId;
        if (githubRepositoryId == null) return new Map();

        const environments = await this.db.previewkitEnvironment.findMany({
            where: {
                organizationId,
                githubRepositoryId,
                prNumber: { in: prNumbers },
                status: { not: "torn_down" },
            },
            // The per-app statuses are what tell a failed build apart from a failed rollout; the
            // environment's own `failed` cannot. One extra column on a row set already bounded by
            // the page's PR numbers.
            select: { prNumber: true, status: true, headSha: true, appInstances: { select: { status: true } } },
            orderBy: { updatedAt: "desc" },
        });

        const stateByPr = new Map<number, { status: string; headSha: string; appStatuses: string[] }>();
        for (const environment of environments) {
            if (stateByPr.has(environment.prNumber)) continue;
            stateByPr.set(environment.prNumber, {
                status: environment.status,
                headSha: environment.headSha,
                appStatuses: environment.appInstances.map((instance) => instance.status),
            });
        }
        return stateByPr;
    }

    /**
     * Rolls a single branch into its {@link PrPipelineStatus} - the same value the PR list computes,
     * exposed for the PR-page and main-branch headers so all three surfaces agree. The main branch has
     * no PR, so its preview environment is resolved as PR 0. See `computePrPipelineStatus`.
     */
    async prPipelineStatusByBranchId(
        applicationId: string,
        branchId: string,
        organizationId: string,
    ): Promise<PrPipelineStatus> {
        this.logger.info("Computing PR pipeline status", { applicationId, branchId });

        const branch = await this.db.branch.findFirst({
            where: { id: branchId, applicationId, application: { organizationId } },
            select: {
                prInfo: { select: { prNumber: true } },
                activeSnapshot: { select: { id: true, status: true, headSha: true } },
            },
        });
        if (branch == null) throw new NotFoundError("Branch not found");

        const prNumber = branch.prInfo?.prNumber ?? 0;
        const activeSnapshots =
            branch.activeSnapshot != null
                ? [{ id: branch.activeSnapshot.id, status: branch.activeSnapshot.status }]
                : [];

        const [healthBySnapshot, lifecycleBySnapshot, previewStateByPr, latestRunByBranch] = await Promise.all([
            aggregateSnapshotHealth(this.db, activeSnapshots, this.logger),
            this.loadLifecycles(
                activeSnapshots.map((s) => s.id),
                organizationId,
            ),
            this.loadPreviewStateByPr(applicationId, organizationId, [prNumber]),
            this.loadLatestRunByBranch([branchId]),
        ]);

        const active = branch.activeSnapshot;
        const summary =
            active != null
                ? presentCheckpoint({
                      lifecycle: lifecycleBySnapshot.get(active.id),
                      healthResult: healthBySnapshot.get(active.id),
                  })?.summary
                : undefined;

        return computePrPipelineStatus({
            activeSnapshot: active != null ? { headSha: active.headSha ?? undefined, summary } : undefined,
            latestRun: latestRunByBranch.get(branchId),
            previewEnv: previewStateByPr.get(prNumber),
        });
    }

    /**
     * The newest non-cancelled snapshot per branch, keyed by branch id. Reached by `branchId` rather than through
     * `branch.activeSnapshotId`/`pendingSnapshotId`, because a failed run sits on neither pointer - the pointer is
     * cleared when the run settles so the branch is not left blocked. Same `where` shape as `listSnapshots`, so the
     * pipeline pill and the checkpoint rail always agree about which run is newest. One query for the whole list.
     */
    private async loadLatestRunByBranch(
        branchIds: string[],
    ): Promise<Map<string, { status: string; headSha?: string }>> {
        return this.suite.latestRuns(branchIds);
    }

    async getBranchByName(applicationId: string, branchName: string, organizationId: string) {
        this.logger.info("Getting branch by name", { applicationId, branchName });

        // Branch names are not unique per application: PR branches store the PR head ref as their name
        // (see upsert-pr-branch), so a PR whose head ref equals the main branch name creates a
        // snapshot-less homonym. Resolve deterministically: the main branch always wins its own name,
        // then the homonym with an active snapshot, then the most recently updated one.
        const [application, candidates] = await Promise.all([
            this.db.application.findFirst({
                where: { id: applicationId, organizationId },
                select: { mainBranchId: true },
            }),
            this.db.branch.findMany({
                where: {
                    applicationId,
                    name: branchName,
                    application: { organizationId },
                },
                orderBy: { updatedAt: "desc" },
                select: {
                    id: true,
                    name: true,
                    pendingSnapshotId: true,
                    createdAt: true,
                    updatedAt: true,
                    activeSnapshot: {
                        select: {
                            id: true,
                            status: true,
                            createdAt: true,
                            source: true,
                            testCaseAssignments: {
                                select: {
                                    id: true,
                                    testCaseId: true,
                                    testCase: { select: { id: true, name: true, slug: true, folderId: true } },
                                    plan: { select: { id: true } },
                                },
                            },
                        },
                    },
                },
            }),
        ]);

        const branch =
            candidates.find((b) => b.id === application?.mainBranchId) ??
            candidates.find((b) => b.activeSnapshot != null) ??
            candidates[0];

        if (branch == null) throw new NotFoundError("Branch not found");
        if (branch.activeSnapshot == null) throw new InternalError("Branch has no active snapshot");

        return { ...branch, activeSnapshot: branch.activeSnapshot };
    }

    /**
     * The branch's snapshot history, newest first. The ordering and the non-cancelled filter are part of the
     * contract and match {@link TestSuiteStore.latestRuns}, so the first element is the branch's latest run
     * and a client never re-sorts to find it.
     */
    async listSnapshots(branchId: string, organizationId: string) {
        this.logger.info("Listing snapshots", { branchId });

        const snapshots = await this.db.branchSnapshot.findMany({
            // Canceled snapshots are abandoned drafts kept only for observability; they are
            // hidden from user-facing history but stay reachable by id via getSnapshotDetail.
            where: {
                branchId,
                branch: { application: { organizationId } },
                status: { not: "cancelled" },
            },
            select: {
                id: true,
                status: true,
                source: true,
                headSha: true,
                baseSha: true,
                createdAt: true,
                prevSnapshotId: true,
                _count: { select: { testCaseAssignments: true } },
            },
            orderBy: { createdAt: "desc" },
            // Bounded because the legacy pull-request overview issues one `snapshotDetail` per
            // snapshot returned here, so an unbounded list fans out without a ceiling on a
            // long-lived pull request. Newest-first, so the cut falls on history nobody scrolls to.
            take: MAX_SNAPSHOTS_LISTED,
        });

        const snapshotIds = snapshots.map((s) => s.id);
        const [changeSummaryBySnapshot, healthBySnapshot, lifecycleBySnapshot] = await Promise.all([
            this.suite.summarizeChanges(
                snapshots.map((s) => ({ snapshotId: s.id, prevSnapshotId: s.prevSnapshotId ?? undefined })),
            ),
            aggregateSnapshotHealth(
                this.db,
                snapshots.map((s) => ({ id: s.id, status: s.status })),
                this.logger,
            ),
            this.loadLifecycles(snapshotIds, organizationId),
        ]);

        return snapshots.map((snapshot) => {
            const changeSummary = changeSummaryBySnapshot.get(snapshot.id) ?? NO_SUITE_CHANGES;
            const checkpoint = presentCheckpoint({
                lifecycle: lifecycleBySnapshot.get(snapshot.id),
                healthResult: healthBySnapshot.get(snapshot.id),
                suiteChangeCount: changeSummary.added + changeSummary.removed + changeSummary.updated,
            });
            return {
                ...snapshot,
                changeSummary,
                health: checkpoint?.health ?? "unknown",
                healthCounts: healthBySnapshot.get(snapshot.id)?.counts ?? {
                    failing: 0,
                    passing: 0,
                    running: 0,
                    setupFailed: 0,
                    notAffected: snapshot._count.testCaseAssignments,
                    totalTests: snapshot._count.testCaseAssignments,
                },
                summary: checkpoint?.summary,
                analyzed: checkpoint != null,
                settled: checkpoint?.settled ?? false,
            };
        });
    }

    async getBranchByPr(applicationId: string, prNumber: number, organizationId: string) {
        this.logger.info("Getting branch by PR", { applicationId, prNumber });

        const branch = await this.db.branch.findFirst({
            where: {
                applicationId,
                prInfo: { prNumber },
                application: { organizationId },
            },
            select: {
                id: true,
                name: true,
                createdAt: true,
                updatedAt: true,
                // Cached GitHub PR metadata. The detail page falls back to this title when the live
                // GitHub fetch is unavailable, matching the PR list (which always reads from cache).
                prInfo: { select: { prNumber: true, prTitle: true } },
            },
        });

        if (branch == null) throw new NotFoundError("Pull request not found");
        if (branch.prInfo == null) throw new InternalError("Branch has no PR info");

        const { prInfo, ...rest } = branch;
        return { ...rest, prNumber: prInfo.prNumber, prTitle: prInfo.prTitle ?? undefined };
    }

    /**
     * `includeCreatedTests` is required rather than defaulted: it costs a query per snapshot, and the aggregate
     * caller (the PR overview card, which fans this out across every snapshot in the PR) must opt out
     * deliberately rather than inherit a default that is only right for the single-snapshot page.
     */
    async getSnapshotDetail(
        snapshotId: string,
        organizationId: string,
        { includeCreatedTests }: { includeCreatedTests: boolean },
    ) {
        this.logger.info("Getting snapshot detail", { snapshotId, includeCreatedTests });

        const snapshot = await this.db.branchSnapshot.findUnique({
            where: { id: snapshotId, branch: { organizationId } },
            select: {
                id: true,
                status: true,
                source: true,
                headSha: true,
                baseSha: true,
                createdAt: true,
                prevSnapshotId: true,
                branch: {
                    select: {
                        id: true,
                        name: true,
                        applicationId: true,
                        prInfo: { select: { prNumber: true } },
                    },
                },
            },
        });

        if (snapshot == null) throw new NotFoundError("Snapshot not found");

        const { prInfo, ...branchRest } = snapshot.branch;
        const { branch: _branch, ...snapshotRest } = snapshot;
        const flatSnapshot = {
            ...snapshotRest,
            branch: { ...branchRest, prNumber: prInfo?.prNumber },
        };

        const changes = await this.suite.changesAgainst(snapshotId, snapshot.prevSnapshotId ?? undefined);

        // Created tests are the assignments added vs. the previous snapshot; resolve them
        // from the already-computed changes so a single diff drives both surfaces. The
        // generation/run inspector they carry is only rendered on the single-snapshot page,
        // so the lean PR-overview fan-out leaves it out (the overview reads added-test runs
        // from executedTests) to avoid extra per-snapshot queries.
        const createdTestCaseIds = changes.filter((c) => c.type === "added").map((c) => c.testCaseId);
        const createdTestsPromise: Promise<SnapshotCreatedTest[]> = includeCreatedTests
            ? loadCreatedTests(this.db, snapshotId, createdTestCaseIds, this.logger)
            : Promise.resolve([]);

        const [executedTests, assignmentCount, createdTests, lifecycleBySnapshot] = await Promise.all([
            listExecutedTestsForSnapshot(this.db, snapshotId),
            this.db.testCaseAssignment.count({ where: { snapshotId } }),
            createdTestsPromise,
            this.loadLifecycles([snapshotId], organizationId),
        ]);
        const counts = this.computeHealthCounts(assignmentCount, executedTests);

        const suiteChangeCount = changes.filter(
            (c) => c.type === "added" || c.type === "updated" || c.type === "removed",
        ).length;
        const health = computeSnapshotHealth(snapshot.status, counts);
        const checkpoint = presentCheckpoint({
            lifecycle: lifecycleBySnapshot.get(snapshotId),
            healthResult: { health, counts },
            suiteChangeCount,
        });

        return {
            snapshot: flatSnapshot,
            changes,
            createdTests,
            health: checkpoint?.health ?? health,
            healthCounts: counts,
            summary: checkpoint?.summary,
            analyzed: checkpoint != null,
            settled: checkpoint?.settled ?? false,
            executedTests,
        };
    }

    private computeHealthCounts(totalTests: number, executedTests: SnapshotExecutedTest[]): SnapshotHealthCounts {
        const tally = tallyExecutedTests(executedTests);

        const replayed = tally.passing + tally.failing + tally.setupFailed + tally.running;
        const notAffected = Math.max(totalTests - replayed, 0);

        return {
            failing: tally.failing,
            passing: tally.passing,
            running: tally.running,
            setupFailed: tally.setupFailed,
            notAffected,
            totalTests,
        };
    }

    async getSnapshotReport(snapshotId: string, organizationId: string): Promise<SnapshotReport> {
        this.logger.info("Getting snapshot report", {
            snapshotId,
        });

        return loadSnapshotReport({
            db: this.db,
            github: this.github,
            snapshotId,
            organizationId,
            parentLogger: this.logger,
        });
    }

    async getActiveSnapshot(branchId: string, organizationId: string) {
        this.logger.info("Getting active snapshot", { branchId });

        const branch = await this.db.branch.findUnique({
            where: { id: branchId, organizationId },
            select: {
                id: true,
                name: true,
                activeSnapshotId: true,
                baseSnapshotId: true,
                activeSnapshot: { select: { prevSnapshotId: true } },
                prInfo: { select: { prNumber: true } },
            },
        });

        if (branch == null) throw new NotFoundError("Branch not found");

        // A branch can have no active checkpoint yet; return an explicit empty state.
        if (branch.activeSnapshotId == null) {
            return {
                hasActiveCheckpoint: false as const,
                branch: { id: branch.id, name: branch.name, prNumber: branch.prInfo?.prNumber },
            };
        }

        const comparisonSnapshotId = deriveForkPointSnapshotId({
            baseSnapshotId: branch.baseSnapshotId ?? undefined,
            activeSnapshotPrevSnapshotId: branch.activeSnapshot?.prevSnapshotId ?? undefined,
        });
        if (comparisonSnapshotId == null) {
            this.logger.warn("Branch has no fork point to compare its active snapshot against", {
                branchId,
                activeSnapshotId: branch.activeSnapshotId,
            });
        }

        const [testSuite, changes] = await Promise.all([
            this.suite.read(branch.activeSnapshotId),
            this.suite.changesAgainst(branch.activeSnapshotId, comparisonSnapshotId),
        ]);

        return {
            hasActiveCheckpoint: true as const,
            snapshotId: branch.activeSnapshotId,
            testSuite,
            changes,
            branch: { id: branch.id, name: branch.name, prNumber: branch.prInfo?.prNumber },
        };
    }

    async getTestSuiteChangesByPr(branchId: string, organizationId: string) {
        this.logger.info("Getting PR-wide test suite changes", { branchId });

        const snapshotSelect = {
            id: true,
            headSha: true,
            createdAt: true,
            prevSnapshotId: true,
            testCaseAssignments: {
                select: {
                    testCaseId: true,
                    planId: true,
                    testCase: { select: { id: true, name: true, slug: true } },
                },
            },
        } as const;

        const branch = await this.db.branch.findUnique({
            where: { id: branchId, organizationId },
            select: {
                id: true,
                activeSnapshotId: true,
                snapshots: {
                    // Exclude cancelled snapshots so the PR-wide rollup reflects the real
                    // lineage; a cancelled draft must never become the latest rollup target.
                    where: { status: { not: "cancelled" } },
                    select: snapshotSelect,
                    orderBy: { createdAt: "asc" },
                },
            },
        });

        if (branch == null) throw new NotFoundError("Branch not found");

        const emptyResult = emptyTestSuiteChanges();

        const prSnapshots = branch.snapshots;
        if (prSnapshots.length === 0) {
            this.logger.warn("Branch has no snapshots", { branchId });
            return emptyResult;
        }

        // Pick the latest PR snapshot as the rollup target. Don't depend on branch.activeSnapshotId
        // being in sync - the rollup should reflect what the user sees as the latest snapshot.
        const activeSnap = prSnapshots[prSnapshots.length - 1]!;

        // The baseline is the earliest PR snapshot's prevSnapshotId (the divergence point on main).
        const baseSnapshotId = prSnapshots[0]?.prevSnapshotId ?? null;
        if (baseSnapshotId == null) {
            this.logger.warn("Earliest PR snapshot has no prevSnapshotId", {
                branchId,
                earliestSnapshotId: prSnapshots[0]?.id,
            });
            return emptyResult;
        }

        const baseSnap = await this.db.branchSnapshot.findUnique({
            where: { id: baseSnapshotId },
            select: snapshotSelect,
        });
        if (baseSnap == null) {
            this.logger.warn("Base snapshot not found", { branchId, baseSnapshotId });
            return emptyResult;
        }

        this.logger.info("Computing PR-wide changes", {
            branchId,
            prSnapshotCount: prSnapshots.length,
            activeSnapshotId: activeSnap.id,
            baseSnapshotId,
            baseAssignmentCount: baseSnap.testCaseAssignments.length,
            activeAssignmentCount: activeSnap.testCaseAssignments.length,
        });

        const changes = computeTestSuiteChanges({ prSnapshots, baseSnap, activeSnap });

        this.logger.info("PR-wide test suite changes computed", {
            branchId,
            added: changes.added.length,
            modified: changes.modified.length,
            removed: changes.removed.length,
        });

        return changes;
    }
}

type PullRequestStateFilter = "open" | "closed" | "merged";

/**
 * Builds the `prInfo` relation filter for a given PR state. We match the cached
 * `prState` exactly and do NOT fold unknown (null) state into "open": before the cache
 * is populated, treating null as open swamped the Open tab with historic closed/merged
 * PRs. The revalidation now classifies every tracked PR (the open-PR list is
 * authoritative - anything not in it is marked closed), so null is only a brief transient
 * state for a freshly tracked PR until the next revalidation, after which it shows under
 * its real tab.
 */
function prInfoStateFilter(state: PullRequestStateFilter): Prisma.FeatureBranchInfoWhereInput {
    return { prState: state };
}

/** A snapshot's checkpoint presentation: the badge summary and the raw health signal - the two fields the PR list,
 * the checkpoint rail and the PR pipeline status each render off one snapshot. */
const PreviewUrlsSchema = z.record(z.string(), z.string());

function firstPreviewUrl(urls: unknown): string | undefined {
    const parsed = PreviewUrlsSchema.safeParse(urls);
    if (!parsed.success) return undefined;
    for (const url of Object.values(parsed.data)) {
        if (url.length > 0) return url;
    }
    return undefined;
}
