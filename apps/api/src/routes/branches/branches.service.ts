import {
    aggregateSnapshotHealth,
    authoritativeSnapshotHealth,
    buildAuthoritativeCheckpointSummary,
    buildCheckpointSummary,
    computeFailingByKind,
    computeSnapshotHealth,
    countOpenBugsBySnapshot,
    failingExecutionIds,
    listExecutedTestsForSnapshot,
    loadAuthoritativeCheckpointInputs,
    type LoadedAuthoritativeInputs,
    loadIssueKindsForExecutions,
    type SnapshotExecutedTest,
    type SnapshotHealthCounts,
    type SnapshotHealthResult,
    type SnapshotHealth,
    tallyExecutedTests,
} from "@autonoma/checkpoint";
import type { AnalysisJobStatus, Prisma } from "@autonoma/db";
import type { PrismaClient } from "@autonoma/db";
import { InternalError, NotFoundError } from "@autonoma/errors";
import type { StorageProvider } from "@autonoma/storage";
import {
    getChangesForSnapshot,
    summarizeChangesForSnapshots,
    fetchTestSuiteInfo,
    type SnapshotChangeSummary,
} from "@autonoma/test-updates";
import {
    type AnalysisForPr,
    type AnalysisIssueDetail,
    type AnalysisIssueFindingInstance,
    analysisIssueKindSchema,
    analysisIssueSeveritySchema,
    analysisIssueStatusSchema,
    type AnalysisIssueSummary,
    analysisFindingSortKey,
    type AnalysisFindingView,
    type AnalysisPrCoveredTest,
    type AnalysisPrIssue,
    type AnalysisPrNewerRun,
    type AnalysisReportData,
    type AnalysisTestOrigin,
    analysisTestOriginSchema,
    type AnalysisVerdict,
    analysisVerdictSchema,
    type AnalysisSnapshotIssueChanges,
    buildAnalysisFindingUrl,
    buildAnalysisIssueUrl,
    buildPrPageUrl,
    type CheckpointPresentationSummary,
    compareAnalysisIssues,
    coverageSummarySchema,
    pickDesignatedRun,
    type EvidenceManifestEntry,
    evidenceManifestEntrySchema,
    extractEvidenceAssetIds,
    type InvestigationFinding,
    type InvestigationReportData,
    type InvestigationRunStep,
    type MainOpenProblems,
    type OverlayPoint,
    type PrimaryScreenshot,
    primaryScreenshotSchema,
    type PrPipelineStatus,
    type ResolvedEvidenceAsset,
    type ResolvedPrimaryScreenshot,
    type SnapshotReport,
    suspectedCauseSchema,
} from "@autonoma/types";
import { findLatestWorkflowBySnapshotId, type WorkflowRef } from "@autonoma/workflow";
import { z } from "zod";
import { env } from "../../env";
import type { GitHubInstallationService } from "../../github/github-installation.service";
import type { PullRequestCacheService } from "../../github/pull-request-cache.service";
import { Service } from "../service";
import { loadCreatedTests, type SnapshotCreatedTest } from "./created-tests";
import { loadFirstIterationReasoning } from "./first-iteration-reasoning";
import { loadMainOpenProblems } from "./main-open-problems";
import { computePrPipelineStatus } from "./pr-pipeline-status";
import { loadRefinementLoop } from "./refinement-loop";
import { loadSnapshotReport } from "./snapshot-report";
import { computeTestSuiteChanges, emptyTestSuiteChanges } from "./test-suite-changes";

export type { TestSuiteChangeRow } from "./test-suite-changes";

/** Signed-URL lifetime for a finding's screenshot/video - short, re-signed on every page load. */
const INVESTIGATION_MEDIA_TTL_SECONDS = 60 * 60;

/** Fallback suite-change counts for a snapshot the batched summary has no entry for. */
const NO_SUITE_CHANGES: SnapshotChangeSummary = { added: 0, removed: 0, updated: 0 };

/**
 * A report should surface an entry point only when it leads somewhere useful: it either has renderable island
 * data (`appSlug` is set - `getInvestigationReportData` returns null otherwise) or is actively running (the
 * live-progress state). This deliberately hides pre-island reports (appSlug null, S3-markdown only) until the
 * backfill migrates them in, and failed rows that never produced a report - both would otherwise open an empty
 * "not available" page. Applied to BOTH presence reads so the entry point and the report page never disagree.
 */
const RENDERABLE_OR_LIVE_REPORT: Prisma.InvestigationReportWhereInput = {
    OR: [{ appSlug: { not: null } }, { status: "running" }],
};

/**
 * Finding categories that make a report "warning"-level (amber entry point): a scenario-data problem or an
 * environment/provisioning failure - actionable, but not a confirmed client bug. Client bugs (red) are counted
 * separately via the denormalized `clientBugCount`; everything else is neutral (gray). Kept as a filtered
 * relation count on the presence reads so the entry point can be colored without loading the findings.
 */
const WARNING_FINDING_CATEGORIES = ["scenario_issue", "environment_failure"];

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
}

/** One PR's investigation entry-point presence (drives the colored pill on the Home + PR lists). */
export interface InvestigationPresenceEntry {
    snapshotId: string;
    clientBugCount: number;
    /** Count of scenario/environment-failure findings - the amber (warning) signal. */
    warningCount: number;
    status: string;
    stage?: string;
}

/** Columns read from an InvestigationFinding row to reconstruct the UI's InvestigationFinding shape. */
const investigationFindingSelect = {
    findingKey: true,
    slug: true,
    category: true,
    confidence: true,
    planFidelity: true,
    falsePositiveRisk: true,
    headline: true,
    whatHappened: true,
    observedAppIssues: true,
    remediation: true,
    rootCause: true,
    suggestedFixDiff: true,
    plan: true,
    runSuccess: true,
    stepCount: true,
    runSteps: true,
    runTrace: true,
    evidence: true,
    videoKey: true,
    screenshotKey: true,
    error: true,
    coveredSlugs: true,
} satisfies Prisma.InvestigationFindingSelect;

const investigationSuggestedTestSelect = {
    name: true,
    instruction: true,
    reasoning: true,
    validationPassed: true,
    validationIterations: true,
    validationFailureReason: true,
} satisfies Prisma.InvestigationSuggestedTestSelect;

type InvestigationFindingRow = Prisma.InvestigationFindingGetPayload<{ select: typeof investigationFindingSelect }>;

/**
 * Columns read to reconstruct the UI's finding shape. The authoritative store mirrors InvestigationFinding but has
 * no planFidelity/suggestedFixDiff (those axes were dropped) and adds the per-test signals the suite-changes
 * surfaces derive their whole view from (the test, origin, selectionReason, and the classification history).
 */

/** The verdict columns one classification contributes to the finding's display shape. */
const analysisClassificationSelect = {
    generationId: true,
    category: true,
    confidence: true,
    falsePositiveRisk: true,
    headline: true,
    expectedBehavior: true,
    actualBehavior: true,
    whatHappened: true,
    planMismatchNote: true,
    invalidTestNote: true,
    observedAppIssues: true,
    remediation: true,
    rootCause: true,
    plan: true,
    runSuccess: true,
    stepCount: true,
    runSteps: true,
    runTrace: true,
    evidence: true,
    videoKey: true,
    optimizedVideoKey: true,
    screenshotKey: true,
    error: true,
} satisfies Prisma.AnalysisClassificationSelect;

/** What the self-heal history shows per iteration: the conclusion, and the two artifacts behind it. */
const analysisClassificationSummarySelect = {
    id: true,
    number: true,
    generationId: true,
    category: true,
    headline: true,
    createdAt: true,
    conversationUrl: true,
} satisfies Prisma.AnalysisClassificationSelect;

const analysisFindingSelect = {
    id: true,
    // The test the finding is about. The suite-changes surfaces list findings by test name, and the slug is what
    // the report's `finding:<slug>` prose tokens resolve through.
    testCase: { select: { id: true, name: true, slug: true } },
    origin: true,
    selectionReason: true,
    // The verdict the run stands behind. Every display field lives here, one row away, so a superseded self-heal
    // iteration cannot be mistaken for the finding's own verdict.
    currentClassification: { select: analysisClassificationSelect },
    // The self-heal history: every iteration oldest-first, the current one included. More than one entry means the
    // Investigator rewrote the plan and re-ran, and each entry keeps the reasoning that produced it.
    classifications: { orderBy: { number: "asc" }, select: analysisClassificationSummarySelect },
    // The branch-scoped issue this finding was clustered into (backfilled by the Reporter), so the finding-detail
    // page can link UP to its stable, cross-snapshot issue. Null for a passing/coverage finding with no issue.
    issueId: true,
    issue: { select: { title: true } },
} satisfies Prisma.AnalysisFindingSelect;

type AnalysisFindingRow = Prisma.AnalysisFindingGetPayload<{ select: typeof analysisFindingSelect }>;

/** Reconstruct the UI's InvestigationFinding from a persisted row (media keys are signed separately, on read). */
function rowToFinding(row: InvestigationFindingRow): InvestigationFinding {
    return {
        id: row.findingKey,
        slug: row.slug,
        category: row.category,
        confidence: row.confidence ?? undefined,
        planFidelity: row.planFidelity ?? undefined,
        falsePositiveRisk: row.falsePositiveRisk ?? undefined,
        headline: row.headline,
        whatHappened: row.whatHappened ?? undefined,
        observedAppIssues: row.observedAppIssues ?? undefined,
        remediation: row.remediation ?? undefined,
        rootCause: row.rootCause ?? undefined,
        suggestedFixDiff: row.suggestedFixDiff ?? undefined,
        evidence: row.evidence ?? [],
        plan: row.plan ?? undefined,
        runSuccess: row.runSuccess ?? undefined,
        stepCount: row.stepCount ?? undefined,
        runSteps: row.runSteps ?? undefined,
        // Each step's screenshotUrl is still a raw s3:// key here; signFindingMedia signs them on read.
        runTrace: row.runTrace ?? undefined,
        // Stored s3:// keys; signFindingMedia turns these into browser-openable URLs.
        videoUrl: row.videoKey ?? undefined,
        keyScreenshotUrl: row.screenshotKey ?? undefined,
        error: row.error ?? undefined,
        coveredSlugs: row.coveredSlugs ?? undefined,
    };
}

/**
 * Reconstruct the UI finding shape from an AnalysisFinding row and its current classification (media keys are
 * signed separately, on read). Returns undefined for a finding with no classification yet - one exists only
 * between its creation and its first verdict, inside a single transaction, so a reader seeing one is looking at a
 * row that has nothing to say.
 */
function rowToAnalysisFinding(row: AnalysisFindingRow): AnalysisFindingView | undefined {
    const current = row.currentClassification;
    if (current == null) return undefined;
    return {
        id: row.id,
        slug: row.testCase.slug,
        generationId: current.generationId,
        testCase: row.testCase,
        origin: parseAnalysisTestOrigin(row.origin),
        selectionReason: row.selectionReason ?? undefined,
        category: current.category,
        confidence: current.confidence ?? undefined,
        falsePositiveRisk: current.falsePositiveRisk ?? undefined,
        headline: current.headline,
        expectedBehavior: current.expectedBehavior ?? undefined,
        actualBehavior: current.actualBehavior ?? undefined,
        whatHappened: current.whatHappened ?? undefined,
        planMismatchNote: current.planMismatchNote ?? undefined,
        invalidTestNote: current.invalidTestNote ?? undefined,
        observedAppIssues: current.observedAppIssues ?? undefined,
        remediation: current.remediation ?? undefined,
        rootCause: current.rootCause ?? undefined,
        evidence: current.evidence ?? [],
        plan: current.plan ?? undefined,
        runSuccess: current.runSuccess ?? undefined,
        stepCount: current.stepCount ?? undefined,
        runSteps: current.runSteps ?? undefined,
        // Each step's screenshotUrl is still a raw s3:// key here; signFindingMedia signs them on read.
        runTrace: current.runTrace ?? undefined,
        // Stored s3:// keys; signFindingMedia turns these into browser-openable URLs.
        videoUrl: current.videoKey ?? undefined,
        optimizedVideoUrl: current.optimizedVideoKey ?? undefined,
        keyScreenshotUrl: current.screenshotKey ?? undefined,
        error: current.error ?? undefined,
        classifications: row.classifications.map((classification) => ({
            id: classification.id,
            number: classification.number,
            generationId: classification.generationId,
            category: classification.category,
            headline: classification.headline,
            createdAt: classification.createdAt,
            // Still the raw s3:// key here; signFindingMedia signs it alongside the finding's media.
            conversationUrl: classification.conversationUrl ?? undefined,
        })),
        issueId: row.issueId ?? undefined,
        issueTitle: row.issue?.title ?? undefined,
    };
}

/**
 * `origin` is stored as a plain string (matching the analysis island's column style), so it is parsed at this
 * boundary. An unrecognized value reads as absent - the surfaces that branch on origin fall back rather than
 * mis-bucketing the test.
 */
function parseAnalysisTestOrigin(origin: string | null): AnalysisTestOrigin | undefined {
    if (origin == null) return undefined;
    const parsed = analysisTestOriginSchema.safeParse(origin);
    return parsed.success ? parsed.data : undefined;
}

/** Columns read from an AnalysisIssue row to build a list/change summary (header + primary screenshot + runs). */
const analysisIssueSummarySelect = {
    id: true,
    title: true,
    kind: true,
    severity: true,
    status: true,
    createdAt: true,
    primaryScreenshot: true,
    // The covered findings' snapshot ids - counted DISTINCT into the recurrence "runs" figure (one run can
    // attribute several findings to the same issue, so a raw finding count would overstate recurrence).
    findings: { select: { reportSnapshotId: true } },
} satisfies Prisma.AnalysisIssueSelect;

type AnalysisIssueSummaryRow = Prisma.AnalysisIssueGetPayload<{ select: typeof analysisIssueSummarySelect }>;

/**
 * Columns one open issue contributes to the by-PR analysis payload. Richer than the list summary, since a reader here
 * is fixing the issue rather than browsing to it; `analysisPrIssueSchema` documents what it leaves out and why.
 */
const analysisPrIssueSelect = {
    id: true,
    title: true,
    kind: true,
    severity: true,
    expectedBehavior: true,
    actualBehavior: true,
    primaryScreenshot: true,
    suspectedCause: true,
    primaryTestCaseId: true,
    // Every finding attributed to this issue: the covered-test list, and the pool the designated reproduction is
    // picked from. Matched in code because the test to match on lives on the parent row, which a nested Prisma
    // filter cannot reference.
    findings: {
        select: {
            id: true,
            testCaseId: true,
            reportSnapshotId: true,
            origin: true,
            selectionReason: true,
            testCase: { select: { slug: true } },
            currentClassification: { select: { category: true, clipKey: true } },
            // Findings key to the AnalysisJob, so the run's timestamp comes via the job's snapshot.
            job: { select: { snapshot: { select: { createdAt: true } } } },
        },
    },
} satisfies Prisma.AnalysisIssueSelect;

type AnalysisPrIssueRow = Prisma.AnalysisIssueGetPayload<{ select: typeof analysisPrIssueSelect }>;
type AnalysisPrIssueFindingRow = AnalysisPrIssueRow["findings"][number];

/**
 * The distinct tests an issue covers, each carrying the verdict and Impact Analysis reasoning from the most recent
 * run that attributed it - one finding exists per (run, test), so the newest run's row is the current story for that
 * test. Slug-ordered so the list is stable across requests.
 */
function coveredTestsForIssue(row: AnalysisPrIssueRow): AnalysisPrCoveredTest[] {
    const newestByTest = new Map<string, AnalysisPrIssueFindingRow>();
    for (const finding of row.findings) {
        const seen = newestByTest.get(finding.testCaseId);
        if (seen == null || finding.job.snapshot.createdAt > seen.job.snapshot.createdAt) {
            newestByTest.set(finding.testCaseId, finding);
        }
    }
    return [...newestByTest.values()]
        .map((finding) => ({
            slug: finding.testCase.slug,
            origin: parseAnalysisTestOrigin(finding.origin),
            selectionReason: finding.selectionReason ?? undefined,
            category: finding.currentClassification?.category ?? "",
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
    latestJob: { status: AnalysisJobStatus; failureReason: string | null; snapshot: { createdAt: Date } },
    reportedRunAt: Date,
): AnalysisPrNewerRun | undefined {
    if (latestJob.snapshot.createdAt <= reportedRunAt) return undefined;
    if (latestJob.status === "running") return { status: "running" };
    if (latestJob.status === "failed") {
        return { status: "failed", failureReason: latestJob.failureReason ?? undefined };
    }
    return undefined;
}

/** Parse a stored evidence-manifest JSON blob at the read boundary; a malformed blob degrades to no evidence. */
function parseEvidenceManifest(json: Prisma.JsonValue | null): EvidenceManifestEntry[] {
    if (json == null) return [];
    const parsed = z.array(evidenceManifestEntrySchema).safeParse(json);
    return parsed.success ? parsed.data : [];
}

/** Parse a stored primary-screenshot JSON blob; a malformed blob degrades to no designated hero. */
function parsePrimaryScreenshot(json: Prisma.JsonValue | null): PrimaryScreenshot | undefined {
    if (json == null) return undefined;
    const parsed = primaryScreenshotSchema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
}

/** Parse a stored suspected-cause JSON blob; a malformed blob degrades to no suspected cause. */
function parseSuspectedCause(json: Prisma.JsonValue | null): AnalysisIssueDetail["suspectedCause"] {
    if (json == null) return undefined;
    const parsed = suspectedCauseSchema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
}

export class BranchesService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly github: GitHubInstallationService,
        private readonly storageProvider: StorageProvider,
        private readonly prCache: PullRequestCacheService,
    ) {
        super();
    }

    /**
     * A lightweight presence + counts check for the snapshot page's "Investigation" entry point (does a report
     * exist, and how many bugs). DB-only - there is no S3 involved. Internal/@autonoma.app surface only; returns
     * undefined when the shadow job has not produced a report for this snapshot. Org-scoped like getSnapshotReport.
     */
    async getInvestigationReport(snapshotId: string, organizationId: string) {
        this.logger.info("Getting investigation report", { extra: { snapshotId } });
        try {
            // Post-#1204 the report lives on the detached investigation twin (hop the pairing FK); pre-#1204
            // investigations ran on the PR snapshot itself and keyed the report directly to it. Match either so
            // historical PRs still surface their report - legacy leg to be dropped once old reports age out.
            // If BOTH exist for one PR (a legacy direct report + a later twin), prefer the twin: it is always the
            // newer row, so createdAt desc picks it. createdAt (not updatedAt) because the backfill bumps
            // updatedAt on legacy rows, which would wrongly favor a just-backfilled legacy report.
            const report = await this.db.investigationReport.findFirst({
                where: {
                    organizationId,
                    AND: [
                        { OR: [{ snapshot: { investigationParent: { id: snapshotId } } }, { snapshotId }] },
                        RENDERABLE_OR_LIVE_REPORT,
                    ],
                },
                orderBy: { createdAt: "desc" },
                select: { testCount: true, clientBugCount: true, status: true, updatedAt: true },
            });
            if (report == null) return undefined;
            return {
                testCount: report.testCount,
                clientBugCount: report.clientBugCount,
                status: report.status,
                updatedAt: report.updatedAt,
            };
        } catch (error) {
            // Optional internal surface - a failure here (table not yet migrated in this env, etc.) must never
            // error the PR view. Degrade to "no report" so the entry point simply doesn't appear.
            this.logger.warn("Could not load investigation report; treating as absent", {
                extra: { snapshotId },
                err: error,
            });
            return undefined;
        }
    }

    /**
     * The same presence, for every pull request of an application in a given state.
     *
     * The snapshot ids are resolved HERE rather than named by the caller. The list views already read these
     * branches from `listBranches`, so having them ship one id per row back is a round trip of the server's own
     * answer - and at a few hundred open pull requests it is ~10KB of `input=` on a batched tRPC GET, which the
     * edge rejects with 414 before any procedure in that batch runs.
     */
    async getInvestigationReportsForApplication(
        applicationId: string,
        organizationId: string,
        state: PullRequestStateFilter = "open",
    ) {
        this.logger.info("Getting investigation reports for application", { applicationId, extra: { state } });

        const branches = await this.db.branch.findMany({
            where: { applicationId, prInfo: prInfoStateFilter(state), application: { organizationId } },
            select: { activeSnapshotId: true },
        });

        const snapshotIds = branches.map((branch) => branch.activeSnapshotId).filter((id): id is string => id != null);

        return await this.getInvestigationReportsForSnapshots(snapshotIds, organizationId);
    }

    /**
     * Batched presence for the PR-list entry points (Home + PR list): given the active snapshot ids of many PRs,
     * return which ones have an investigation report and its bug count + lifecycle status. Batched deliberately -
     * a per-PR fetch would N+1 the list. Matches the twin's report (via the pairing FK) or a legacy report keyed
     * directly to the PR snapshot, and keys the result back to the PR snapshot id the UI routes on. Internal/
     * @autonoma.app only; degrades to an empty list on any failure. Org-scoped.
     */
    async getInvestigationReportsForSnapshots(snapshotIds: string[], organizationId: string) {
        this.logger.info("Getting investigation reports for snapshots", { extra: { count: snapshotIds.length } });
        if (snapshotIds.length === 0) return [];
        try {
            const requested = new Set(snapshotIds);
            const reports = await this.db.investigationReport.findMany({
                where: {
                    organizationId,
                    AND: [
                        {
                            OR: [
                                { snapshotId: { in: snapshotIds } },
                                { snapshot: { investigationParent: { id: { in: snapshotIds } } } },
                            ],
                        },
                        RENDERABLE_OR_LIVE_REPORT,
                    ],
                },
                // Newest first so the first row seen for a PR snapshot (the twin, post-#1204) wins over an older
                // legacy row for the same PR.
                orderBy: { createdAt: "desc" },
                select: {
                    snapshotId: true,
                    clientBugCount: true,
                    status: true,
                    stage: true,
                    snapshot: { select: { investigationParent: { select: { id: true } } } },
                    _count: { select: { findings: { where: { category: { in: WARNING_FINDING_CATEGORIES } } } } },
                },
            });

            const seen = new Set<string>();
            const presence: InvestigationPresenceEntry[] = [];
            for (const report of reports) {
                const parentId = report.snapshot.investigationParent?.id;
                const prSnapshotId = parentId != null && requested.has(parentId) ? parentId : report.snapshotId;
                if (!requested.has(prSnapshotId) || seen.has(prSnapshotId)) continue;
                seen.add(prSnapshotId);
                presence.push({
                    snapshotId: prSnapshotId,
                    clientBugCount: report.clientBugCount,
                    warningCount: report._count.findings,
                    status: report.status,
                    stage: report.stage ?? undefined,
                });
            }
            return presence;
        } catch (error) {
            // Optional internal surface - a failure here must never sink the PR list. Degrade to "none".
            this.logger.warn("Could not load investigation reports for snapshots; treating as none", { err: error });
            return [];
        }
    }

    /**
     * The structured investigation report for the in-app "View investigation" page. Reads the queryable island
     * tables the worker persists (InvestigationReport + findings/suggested) and re-signs each finding's s3://
     * media into browser-openable URLs - the DB is the single source of truth (no S3 report blob). Reports
     * written before the island cutover have no denormalized header until the backfill script runs; those return
     * null here (the page shows a graceful "not available"). Internal/@autonoma.app only; degrades to null on any
     * failure. Org-scoped.
     *
     * Returns `null`, never `undefined`, for absence: this is consumed by a React Query query whose queryFn must
     * not resolve to `undefined` (React Query throws "data is undefined" and crashes the page's error boundary,
     * before the component's graceful `data == null` branch can render). `null` is a valid resolved value.
     */
    async getInvestigationReportData(
        snapshotId: string,
        organizationId: string,
    ): Promise<InvestigationReportData | null> {
        this.logger.info("Getting investigation report data", { extra: { snapshotId } });
        try {
            // Twin's report (post-#1204) or a legacy report keyed directly to the PR snapshot (pre-#1204), so
            // historical PRs keep their rich report. When both exist for one PR, prefer the twin - it is the newer
            // row, so createdAt desc picks it (createdAt, not updatedAt, since the backfill bumps updatedAt on
            // legacy rows). Legacy leg to be dropped once old reports age out.
            const report = await this.db.investigationReport.findFirst({
                where: {
                    organizationId,
                    OR: [{ snapshot: { investigationParent: { id: snapshotId } } }, { snapshotId }],
                },
                orderBy: { createdAt: "desc" },
                select: {
                    client: true,
                    appSlug: true,
                    prNumber: true,
                    prTitle: true,
                    prBody: true,
                    repoFullName: true,
                    commitSha: true,
                    deployed: true,
                    findings: { orderBy: { displayOrder: "asc" }, select: investigationFindingSelect },
                    suggestedTests: { orderBy: { displayOrder: "asc" }, select: investigationSuggestedTestSelect },
                },
            });
            if (report == null) return null;

            // The island persister always writes the denormalized header (appSlug is a required field of the
            // report data), so appSlug != null reliably marks an island report - even one with zero findings.
            // Pre-island rows never had a header; they render only once the backfill script migrates them in.
            if (report.appSlug == null) return null;

            const findings = await Promise.all(
                report.findings.map((finding) => this.signFindingMedia(rowToFinding(finding))),
            );
            return {
                client: report.client ?? "",
                appSlug: report.appSlug,
                prNumber: report.prNumber ?? 0,
                prTitle: report.prTitle ?? undefined,
                prBody: report.prBody ?? undefined,
                repoFullName: report.repoFullName ?? undefined,
                commitSha: report.commitSha ?? undefined,
                findings,
                suggested: report.suggestedTests.map((test) => ({
                    name: test.name,
                    instruction: test.instruction,
                    reasoning: test.reasoning,
                    validation:
                        test.validationPassed != null
                            ? {
                                  passed: test.validationPassed,
                                  iterations: test.validationIterations ?? 0,
                                  failureReason: test.validationFailureReason ?? undefined,
                              }
                            : undefined,
                })),
                deployed: report.deployed ?? undefined,
            };
        } catch (error) {
            // A transient DB error must never error the page - degrade to "no rich report" and let the page
            // render its graceful fallback.
            this.logger.warn("Could not load structured investigation report; treating as absent", {
                extra: { snapshotId },
                err: error,
            });
            return null;
        }
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
            // The AnalysisReport exists only once the Reporter has authored it, so its presence means the run has
            // landed; absence => still running or failed, and the page polls the AnalysisJob-status fallback.
            // Checked first so a still-running poll never fetches findings it would discard.
            const report = await this.db.analysisReport.findFirst({
                where: { snapshotId, organizationId },
                select: {
                    reportMarkdown: true,
                    summary: true,
                    evidenceManifest: true,
                    verdict: true,
                    clientBugCount: true,
                    testCount: true,
                    impactReasoning: true,
                    snapshot: { select: { branchId: true } },
                },
            });
            if (report == null) return null;

            // Findings are keyed to the job (no finding -> report FK); load them separately by the snapshot PK. The
            // slug orders the query so the list is stable: the bucket sort below ranks a whole bucket equally, so
            // without it Postgres row order would decide who comes first and the list could reshuffle per request.
            const findingRows = await this.db.analysisFinding.findMany({
                where: { reportSnapshotId: snapshotId, organizationId },
                orderBy: { testCase: { slug: "asc" } },
                select: analysisFindingSelect,
            });
            const views = findingRows.flatMap((row) => {
                const view = rowToAnalysisFinding(row);
                return view != null ? [view] : [];
            });
            // Stable sort, so findings stay slug-ordered within their bucket.
            const sorted = views.sort(
                (left, right) => analysisFindingSortKey(left.category) - analysisFindingSortKey(right.category),
            );
            const [findings, reportEvidence] = await Promise.all([
                Promise.all(sorted.map((finding) => this.signAnalysisFinding(finding))),
                this.signEvidenceManifest(report.reportMarkdown, parseEvidenceManifest(report.evidenceManifest)),
            ]);
            this.logger.info("Analysis report data assembled", {
                extra: { snapshotId, findingCount: findings.length, reportEvidenceCount: reportEvidence.length },
            });
            return {
                branchId: report.snapshot.branchId,
                impactReasoning: report.impactReasoning ?? undefined,
                // Both prose columns are NOT NULL, but a row predating the Reporter that had no narration to backfill
                // from carries "". Absence is expressed once, here, so no consumer repeats the check.
                reportMarkdown: report.reportMarkdown !== "" ? report.reportMarkdown : undefined,
                summary: report.summary !== "" ? report.summary : undefined,
                reportEvidence,
                verdict: this.toAppHealthVerdict(report.verdict, snapshotId),
                clientBugCount: report.clientBugCount,
                testCount: report.testCount,
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
     * The authoritative `AnalysisJob` lifecycle for a snapshot: the merged pipeline's own status row (mirroring a
     * `DiffsJob`). Returns `null` for a diffs snapshot (no `AnalysisJob`), so the PR page can tell an authoritative
     * snapshot apart from a diffs one even before any `AnalysisReport` exists - the running-snapshot fallback reads
     * this to show the run's status while findings are still being produced. Org-scoped, keyed 1:1 by snapshot.
     *
     * Degrades to `null` on any failure, like `getAnalysisReportData`: this is the PR page's gate query (the whole
     * layout branches on it), so a transient DB error must fall back to the diffs layout, never crash the page.
     */
    async getAnalysisJobStatus(snapshotId: string, organizationId: string): Promise<AnalysisJobStatusView | null> {
        this.logger.info("Getting analysis job status", { extra: { snapshotId } });
        try {
            const job = await this.db.analysisJob.findFirst({
                where: { snapshotId, organizationId },
                select: { status: true, failureReason: true, startedAt: true, completedAt: true },
            });
            if (job == null) {
                this.logger.info("No analysis job for snapshot; treating as a diffs snapshot", {
                    extra: { snapshotId },
                });
                return null;
            }
            return {
                status: job.status,
                failureReason: job.failureReason ?? undefined,
                startedAt: job.startedAt ?? undefined,
                completedAt: job.completedAt ?? undefined,
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
     * The branch's analysis issues (all statuses), for the PR page. The page shows only the OPEN ones in the
     * issues-first list, but returns resolved issues too so the report prose's `issue:<id>` tokens can link a
     * resolved issue (e.g. "resolved [X](issue:...) this checkpoint") instead of treating it as fabricated - the
     * issue-detail page renders resolved issues fully. Issues are branch-scoped (they evolve across snapshots), so
     * this reads by branch, not snapshot. Malformed rows (a kind/severity/status that fails to parse) are skipped.
     * Ordered bugs-first then by descending severity via the shared `compareAnalysisIssues` SSOT. Degrades to an
     * empty list on any failure (never crashes the PR overview).
     */
    async getAnalysisIssues(branchId: string, organizationId: string): Promise<AnalysisIssueSummary[]> {
        this.logger.info("Getting analysis issues", { extra: { branchId } });
        try {
            const issues = await this.db.analysisIssue.findMany({
                where: { branchId, organizationId },
                select: analysisIssueSummarySelect,
            });
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
     * Everything unresolved on the application's main branch, from whichever store owns it - the one read behind
     * the overview rail and the main-branch page's problem list. See {@link loadMainOpenProblems} for the fork.
     */
    async getMainOpenProblems(applicationId: string, organizationId: string): Promise<MainOpenProblems> {
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
            const issue = await this.db.analysisIssue.findFirst({
                where: { id: issueId, organizationId },
                select: {
                    id: true,
                    title: true,
                    kind: true,
                    severity: true,
                    status: true,
                    expectedBehavior: true,
                    actualBehavior: true,
                    narrativeMarkdown: true,
                    evidenceManifest: true,
                    primaryScreenshot: true,
                    suspectedCause: true,
                    resolvedAt: true,
                    findings: {
                        select: {
                            id: true,
                            testCase: { select: { slug: true } },
                            currentClassification: { select: { category: true, headline: true } },
                            reportSnapshotId: true,
                            // Findings key to the AnalysisJob (no report FK); reach the snapshot via the job.
                            job: { select: { snapshot: { select: { createdAt: true, headSha: true } } } },
                        },
                    },
                },
            });
            if (issue == null) return null;

            const kind = analysisIssueKindSchema.safeParse(issue.kind);
            const severity = analysisIssueSeveritySchema.safeParse(issue.severity);
            const status = analysisIssueStatusSchema.safeParse(issue.status);
            if (!kind.success || !severity.success || !status.success) {
                this.logger.warn("Analysis issue has a malformed enum column; treating as absent", {
                    extra: { issueId, kind: issue.kind, severity: issue.severity, status: issue.status },
                });
                return null;
            }

            const primary = parsePrimaryScreenshot(issue.primaryScreenshot);
            const [evidence, primaryScreenshot] = await Promise.all([
                this.signEvidenceManifest(issue.narrativeMarkdown, parseEvidenceManifest(issue.evidenceManifest)),
                primary != null ? this.signPrimaryScreenshot(primary) : Promise.resolve(undefined),
            ]);

            const findingInstances = this.toIssueFindingInstances(issue.findings);
            this.logger.info("Analysis issue detail assembled", {
                extra: { issueId, instanceCount: findingInstances.length, evidenceCount: evidence.length },
            });
            return {
                id: issue.id,
                title: issue.title,
                kind: kind.data,
                severity: severity.data,
                status: status.data,
                expectedBehavior: issue.expectedBehavior ?? undefined,
                actualBehavior: issue.actualBehavior,
                narrativeMarkdown: issue.narrativeMarkdown,
                evidence,
                suspectedCause: parseSuspectedCause(issue.suspectedCause),
                primaryScreenshot,
                resolvedAt: issue.resolvedAt ?? undefined,
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
            const job = await this.db.analysisJob.findFirst({
                where: { snapshotId, organizationId },
                select: {
                    startedAt: true,
                    completedAt: true,
                    snapshot: { select: { branchId: true, createdAt: true } },
                },
            });
            if (job == null) return empty;
            const windowStart = job.startedAt ?? job.snapshot.createdAt;
            const windowEnd = job.completedAt ?? new Date();

            const [touched, resolvedRows] = await Promise.all([
                this.db.analysisIssue.findMany({
                    where: { organizationId, findings: { some: { reportSnapshotId: snapshotId } } },
                    select: analysisIssueSummarySelect,
                }),
                this.db.analysisIssue.findMany({
                    where: {
                        branchId: job.snapshot.branchId,
                        organizationId,
                        status: "resolved",
                        resolvedAt: { gte: windowStart, lte: windowEnd },
                    },
                    select: analysisIssueSummarySelect,
                }),
            ]);

            const openedRows = touched.filter((issue) => issue.createdAt >= windowStart);
            const carriedRows = touched.filter((issue) => issue.createdAt < windowStart);
            const [opened, carriedForward, resolved] = await Promise.all([
                this.toIssueSummaries(openedRows),
                this.toIssueSummaries(carriedRows),
                this.toIssueSummaries(resolvedRows),
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

            // The newest report, the newest job, and the branch's open issues are independent reads: the job answers
            // "is a run going" even when a report exists, and the issues are branch-scoped, so none feeds another.
            const [report, latestJob, issueRows] = await Promise.all([
                this.db.analysisReport.findFirst({
                    where: { organizationId, snapshot: { branchId: branch.id } },
                    orderBy: { snapshot: { createdAt: "desc" } },
                    select: {
                        snapshotId: true,
                        verdict: true,
                        summary: true,
                        reportMarkdown: true,
                        evidenceManifest: true,
                        coverage: true,
                        testCount: true,
                        clientBugCount: true,
                        impactReasoning: true,
                        snapshot: { select: { createdAt: true } },
                    },
                }),
                this.db.analysisJob.findFirst({
                    where: { organizationId, snapshot: { branchId: branch.id } },
                    orderBy: { snapshot: { createdAt: "desc" } },
                    select: { status: true, failureReason: true, snapshot: { select: { createdAt: true } } },
                }),
                this.db.analysisIssue.findMany({
                    where: { branchId: branch.id, organizationId, status: "open" },
                    // The comparator below ranks only kind then severity, and the sort is stable - so without a
                    // deterministic tiebreaker two equally-severe bugs would come back in whatever order Postgres
                    // produced and could reshuffle between identical calls.
                    orderBy: { id: "asc" },
                    select: analysisPrIssueSelect,
                }),
            ]);

            // No job at all means this PR was never analyzed by this pipeline - distinct from a run that produced
            // nothing, so the caller can point the reader somewhere else instead of claiming the PR is clean.
            if (latestJob == null) {
                this.logger.info("No analysis job for PR", { applicationId, prNumber });
                return { status: "no_analysis" };
            }
            if (report == null) {
                if (latestJob.status === "failed") {
                    this.logger.info("Analysis run failed before producing a report", { applicationId, prNumber });
                    return { status: "failed", failureReason: latestJob.failureReason ?? undefined };
                }
                this.logger.info("Analysis run has not produced a report yet", { applicationId, prNumber });
                return { status: "in_progress" };
            }

            const appSlug = branch.application.slug;
            const [issues, reportEvidence] = await Promise.all([
                this.toPrIssues(issueRows, appSlug, prNumber),
                this.signEvidenceManifest(report.reportMarkdown, parseEvidenceManifest(report.evidenceManifest)),
            ]);
            const coverage = coverageSummarySchema.safeParse(report.coverage);

            this.logger.info("Analysis for PR assembled", {
                applicationId,
                prNumber,
                extra: { snapshotId: report.snapshotId, issueCount: issues.length },
            });
            return {
                status: "complete",
                verdict: this.toAppHealthVerdict(report.verdict, report.snapshotId),
                // Both prose columns are NOT NULL, but a row predating the Reporter carries "" - treat empty as absent.
                summary: report.summary !== "" ? report.summary : undefined,
                reportMarkdown: report.reportMarkdown !== "" ? report.reportMarkdown : undefined,
                reportEvidence,
                coverage: coverage.success ? coverage.data : undefined,
                testCount: report.testCount,
                clientBugCount: report.clientBugCount,
                impactReasoning: report.impactReasoning ?? undefined,
                prUrl: buildPrPageUrl(env.APP_URL, appSlug, prNumber),
                issues,
                newerRun: newerRunFrom(latestJob, report.snapshot.createdAt),
            };
        } catch (error) {
            this.logger.warn("Could not load analysis for PR", { applicationId, prNumber, err: error });
            throw error;
        }
    }

    /** Validate + order the open issues (most actionable first, via the shared comparator), mapping each for the API. */
    private async toPrIssues(
        rows: AnalysisPrIssueRow[],
        appSlug: string,
        prNumber: number,
    ): Promise<AnalysisPrIssue[]> {
        const mapped = await Promise.all(rows.map((row) => this.toPrIssue(row, appSlug, prNumber)));
        return mapped
            .filter((issue): issue is AnalysisPrIssue => issue != null)
            .sort((left, right) => compareAnalysisIssues(left, right));
    }

    /**
     * One open issue as an API consumer reads it: the behavior claim, the grounded cause, signed media, and the two
     * links that mean different things - the branch-scoped ISSUE (the cross-snapshot case) and the specific RUN that
     * reproduces it. A malformed enum column skips the row rather than surfacing it half-parsed.
     */
    private async toPrIssue(
        row: AnalysisPrIssueRow,
        appSlug: string,
        prNumber: number,
    ): Promise<AnalysisPrIssue | undefined> {
        const kind = analysisIssueKindSchema.safeParse(row.kind);
        const severity = analysisIssueSeveritySchema.safeParse(row.severity);
        if (!kind.success || !severity.success) {
            this.logger.warn("Skipping analysis issue with a malformed enum column", {
                extra: { issueId: row.id, kind: row.kind, severity: row.severity },
            });
            return undefined;
        }

        const designated = pickDesignatedRun(row.primaryTestCaseId ?? undefined, row.findings);
        const primary = parsePrimaryScreenshot(row.primaryScreenshot);
        const clipKey = designated?.currentClassification?.clipKey ?? undefined;
        const [screenshotUrl, clipUrl] = await Promise.all([
            primary != null ? this.signMediaUrl(primary.s3Key) : undefined,
            clipKey != null ? this.signMediaUrl(clipKey) : undefined,
        ]);

        return {
            id: row.id,
            title: row.title,
            kind: kind.data,
            severity: severity.data,
            expectedBehavior: row.expectedBehavior ?? undefined,
            actualBehavior: row.actualBehavior,
            suspectedCause: parseSuspectedCause(row.suspectedCause),
            screenshotUrl,
            clipUrl,
            // Distinct snapshots, not finding rows: one run can attribute several findings to the same issue.
            runCount: new Set(row.findings.map((finding) => finding.reportSnapshotId)).size,
            issueUrl: buildAnalysisIssueUrl(env.APP_URL, appSlug, prNumber, row.id),
            // Unlike the PR comment (which only offers a replay when there is a clip to watch), the run link is worth
            // returning whenever a reproduction was designated - a reader here can inspect the run itself.
            replayUrl:
                designated != null
                    ? buildAnalysisFindingUrl(
                          env.APP_URL,
                          appSlug,
                          prNumber,
                          designated.reportSnapshotId,
                          designated.id,
                      )
                    : undefined,
            coveredTests: coveredTestsForIssue(row),
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
     * The latest investigation report for a pull request, resolved from `applicationId + prNumber` rather than a
     * snapshot id. Picks the PR's newest primary checkpoint (twins and cancelled drafts excluded, mirroring
     * `listSnapshots`) and loads its report via `getInvestigationReportData` (which handles the twin/legacy report
     * and signs the media). Returns null when the PR has no branch, no checkpoint, or no renderable report yet.
     * Org-scoped. Used by the MCP `get_investigation` tool so a coding agent can pull the findings by repo + PR
     * without an in-app login.
     */
    async getInvestigationReportForPr(
        applicationId: string,
        prNumber: number,
        organizationId: string,
    ): Promise<InvestigationReportData | null> {
        this.logger.info("Getting investigation report for PR", { applicationId, prNumber });
        const snapshotId = await this.resolveLatestInvestigationCheckpoint(applicationId, prNumber, organizationId);
        if (snapshotId == null) return null;

        const report = await this.getInvestigationReportData(snapshotId, organizationId);
        if (report == null) {
            this.logger.info("Investigation checkpoint has no renderable report for PR", { applicationId, prNumber });
        }
        return report;
    }

    /**
     * Lightweight resolution for the false-positive MCP tool: the id of the PR's latest investigation checkpoint plus
     * only the `findingKey`s in its report. Mirrors {@link getInvestigationReportForPr}'s snapshot + twin/legacy
     * report resolution (so a `findingId` the client saw via `get_investigation` resolves identically), but selects
     * only what an id match needs). Returns undefined when the PR has no branch, no checkpoint, or no renderable
     * report. The candidate is keyed to `(snapshotId, findingKey)` since findings are recreated per push, so a
     * findingKey is stable only within one snapshot's report.
     */
    async resolveInvestigationFindingKeysForPr(
        applicationId: string,
        prNumber: number,
        organizationId: string,
    ): Promise<{ snapshotId: string; findingKeys: string[] } | undefined> {
        this.logger.info("Resolving investigation finding keys for PR", { applicationId, prNumber });
        const snapshotId = await this.resolveLatestInvestigationCheckpoint(applicationId, prNumber, organizationId);
        if (snapshotId == null) return undefined;

        const report = await this.db.investigationReport.findFirst({
            where: {
                organizationId,
                OR: [{ snapshot: { investigationParent: { id: snapshotId } } }, { snapshotId }],
            },
            orderBy: { createdAt: "desc" },
            select: {
                appSlug: true,
                findings: { orderBy: { displayOrder: "asc" }, select: { findingKey: true } },
            },
        });
        if (report?.appSlug == null) {
            this.logger.info("No renderable investigation report for PR; nothing to match a finding against", {
                applicationId,
                prNumber,
            });
            return undefined;
        }

        return { snapshotId, findingKeys: report.findings.map((finding) => finding.findingKey) };
    }

    /** The PR's newest primary investigation checkpoint (twins and cancelled drafts excluded), or undefined. Org-scoped. */
    private async resolveLatestInvestigationCheckpoint(
        applicationId: string,
        prNumber: number,
        organizationId: string,
    ): Promise<string | undefined> {
        const branch = await this.db.branch.findFirst({
            where: { applicationId, prInfo: { prNumber }, application: { organizationId } },
            select: { id: true },
        });
        if (branch == null) {
            this.logger.info("No tracked branch for PR; cannot resolve investigation checkpoint", {
                applicationId,
                prNumber,
            });
            return undefined;
        }

        const snapshot = await this.db.branchSnapshot.findFirst({
            where: {
                branchId: branch.id,
                status: { not: "cancelled" },
                investigationParent: { is: null },
            },
            orderBy: { createdAt: "desc" },
            select: { id: true },
        });
        if (snapshot == null) {
            this.logger.info("No non-cancelled primary snapshot for PR; no investigation checkpoint", {
                applicationId,
                prNumber,
            });
            return undefined;
        }
        return snapshot.id;
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

    /**
     * The run's stored verdict as the typed enum. The column is a plain string (matching the analysis island), and
     * the Reporter only ever writes `client_bug` or `passed`. An unrecognized value degrades to `client_bug`: the
     * verdict gates whether the PR reads as healthy, so an unreadable one must not be reported as a clean pass.
     */
    private toAppHealthVerdict(stored: string, snapshotId: string): AnalysisVerdict {
        const parsed = analysisVerdictSchema.safeParse(stored);
        if (parsed.success) return parsed.data;
        this.logger.warn("Analysis report has an unrecognized verdict; reporting it as a bug rather than a pass", {
            extra: { snapshotId, verdict: stored },
        });
        return analysisVerdictSchema.enum.client_bug;
    }

    /** Map + validate a batch of issue rows into summaries, dropping malformed ones, ordered bugs-first/severity. */
    private async toIssueSummaries(rows: AnalysisIssueSummaryRow[]): Promise<AnalysisIssueSummary[]> {
        const summaries = await Promise.all(rows.map((row) => this.toIssueSummary(row)));
        return summaries
            .filter((summary): summary is AnalysisIssueSummary => summary != null)
            .sort(compareAnalysisIssues);
    }

    /** One issue row → its list/change summary: validated header + signed thumbnail + distinct-run recurrence. */
    private async toIssueSummary(row: AnalysisIssueSummaryRow): Promise<AnalysisIssueSummary | undefined> {
        const kind = analysisIssueKindSchema.safeParse(row.kind);
        const severity = analysisIssueSeveritySchema.safeParse(row.severity);
        const status = analysisIssueStatusSchema.safeParse(row.status);
        if (!kind.success || !severity.success || !status.success) {
            this.logger.warn("Skipping malformed analysis issue in list", {
                extra: { issueId: row.id, kind: row.kind, severity: row.severity, status: row.status },
            });
            return undefined;
        }
        const thumbnailUrl = await this.signIssueThumbnail(parsePrimaryScreenshot(row.primaryScreenshot));
        // Distinct snapshots, not finding rows: one run can attribute several findings to the same issue.
        const runCount = new Set(row.findings.map((finding) => finding.reportSnapshotId)).size;
        return {
            id: row.id,
            title: row.title,
            kind: kind.data,
            severity: severity.data,
            status: status.data,
            thumbnailUrl,
            runCount,
        };
    }

    /**
     * Flatten an issue's covered findings into cross-snapshot instances, newest snapshot first. Each instance
     * shows the verdict its run stands behind, so a finding still mid-run (no classification yet) is skipped
     * rather than listed with nothing to say.
     */
    private toIssueFindingInstances(
        findings: {
            id: string;
            testCase: { slug: string };
            currentClassification: { category: string; headline: string } | null;
            reportSnapshotId: string;
            job: { snapshot: { createdAt: Date; headSha: string | null } };
        }[],
    ): AnalysisIssueFindingInstance[] {
        return findings
            .flatMap((finding) => {
                if (finding.currentClassification == null) return [];
                return [
                    {
                        snapshotId: finding.reportSnapshotId,
                        snapshotCreatedAt: finding.job.snapshot.createdAt,
                        headSha: finding.job.snapshot.headSha ?? undefined,
                        findingId: finding.id,
                        slug: finding.testCase.slug,
                        category: finding.currentClassification.category,
                        headline: finding.currentClassification.headline,
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
        narrativeMarkdown: string,
        manifest: EvidenceManifestEntry[],
    ): Promise<ResolvedEvidenceAsset[]> {
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

    async listBranches(applicationId: string, organizationId: string, state: PullRequestStateFilter = "open") {
        this.logger.info("Listing branches", { applicationId, extra: { state } });

        const branches = await this.db.branch.findMany({
            where: { applicationId, prInfo: prInfoStateFilter(state), application: { organizationId } },
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
            orderBy: { createdAt: "desc" },
        });

        const activeSnapshots = branches
            .map((b) => b.activeSnapshot)
            .filter((s): s is NonNullable<typeof s> => s != null)
            .map((s) => ({ id: s.id, status: s.status }));

        const [
            healthBySnapshot,
            bugCountBySnapshot,
            authoritativeBySnapshot,
            previewUrlByPr,
            previewStateByPr,
            latestRunByBranch,
        ] = await Promise.all([
            aggregateSnapshotHealth(this.db, activeSnapshots, this.logger),
            countOpenBugsBySnapshot(
                this.db,
                activeSnapshots.map((s) => s.id),
            ),
            loadAuthoritativeCheckpointInputs(
                this.db,
                organizationId,
                activeSnapshots.map((s) => s.id),
                this.logger,
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

        return branches.map(({ prInfo, activeSnapshot, ...branch }) => {
            // No active snapshot: nothing to present. A snapshot that exists always goes through `presentCheckpoint`,
            // the one place the legacy-vs-authoritative fork lives.
            const { summary, health, bugCount } =
                activeSnapshot != null
                    ? presentCheckpoint({
                          snapshotStatus: activeSnapshot.status,
                          healthResult: healthBySnapshot.get(activeSnapshot.id),
                          legacyBugCount: bugCountBySnapshot.get(activeSnapshot.id) ?? 0,
                          authoritative: authoritativeBySnapshot.get(activeSnapshot.id),
                      })
                    : { summary: undefined, health: "unknown" as const, bugCount: 0 };

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
                bugCount,
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
    ): Promise<Map<number, { status: string; headSha: string }>> {
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
            select: { prNumber: true, status: true, headSha: true },
            orderBy: { updatedAt: "desc" },
        });

        const stateByPr = new Map<number, { status: string; headSha: string }>();
        for (const environment of environments) {
            if (stateByPr.has(environment.prNumber)) continue;
            stateByPr.set(environment.prNumber, { status: environment.status, headSha: environment.headSha });
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

        const [healthBySnapshot, bugCountBySnapshot, authoritativeBySnapshot, previewStateByPr, latestRunByBranch] =
            await Promise.all([
                aggregateSnapshotHealth(this.db, activeSnapshots, this.logger),
                countOpenBugsBySnapshot(
                    this.db,
                    activeSnapshots.map((s) => s.id),
                ),
                loadAuthoritativeCheckpointInputs(
                    this.db,
                    organizationId,
                    activeSnapshots.map((s) => s.id),
                    this.logger,
                ),
                this.loadPreviewStateByPr(applicationId, organizationId, [prNumber]),
                this.loadLatestRunByBranch([branchId]),
            ]);

        const active = branch.activeSnapshot;
        const summary =
            active != null
                ? presentCheckpoint({
                      snapshotStatus: active.status,
                      healthResult: healthBySnapshot.get(active.id),
                      legacyBugCount: bugCountBySnapshot.get(active.id) ?? 0,
                      authoritative: authoritativeBySnapshot.get(active.id),
                  }).summary
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
        if (branchIds.length === 0) return new Map();

        const snapshots = await this.db.branchSnapshot.findMany({
            where: {
                branchId: { in: branchIds },
                status: { not: "cancelled" },
                investigationParent: { is: null },
            },
            orderBy: { createdAt: "desc" },
            distinct: ["branchId"],
            select: { branchId: true, status: true, headSha: true },
        });

        return new Map(
            snapshots.map((s) => [s.branchId, { status: s.status, headSha: s.headSha ?? undefined }] as const),
        );
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

    async listSnapshots(branchId: string, organizationId: string) {
        this.logger.info("Listing snapshots", { branchId });

        const snapshots = await this.db.branchSnapshot.findMany({
            // Canceled snapshots are abandoned drafts kept only for observability; they are
            // hidden from user-facing history but stay reachable by id via getSnapshotDetail.
            // The detached investigation twin (non-null investigationParent) is likewise hidden - it is
            // not part of the branch's user-facing lineage.
            where: {
                branchId,
                branch: { application: { organizationId } },
                status: { not: "cancelled" },
                investigationParent: { is: null },
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
        });

        const snapshotIds = snapshots.map((s) => s.id);
        const [changeSummaryBySnapshot, healthBySnapshot, bugCountBySnapshot, authoritativeBySnapshot] =
            await Promise.all([
                summarizeChangesForSnapshots(
                    this.db,
                    snapshots.map((s) => ({ snapshotId: s.id, prevSnapshotId: s.prevSnapshotId })),
                    this.logger,
                ),
                aggregateSnapshotHealth(
                    this.db,
                    snapshots.map((s) => ({ id: s.id, status: s.status })),
                    this.logger,
                ),
                countOpenBugsBySnapshot(this.db, snapshotIds),
                loadAuthoritativeCheckpointInputs(this.db, organizationId, snapshotIds, this.logger),
            ]);

        return snapshots.map((snapshot) => {
            const changeSummary = changeSummaryBySnapshot.get(snapshot.id) ?? NO_SUITE_CHANGES;
            const { summary, health, bugCount } = presentCheckpoint({
                snapshotStatus: snapshot.status,
                healthResult: healthBySnapshot.get(snapshot.id),
                legacyBugCount: bugCountBySnapshot.get(snapshot.id) ?? 0,
                authoritative: authoritativeBySnapshot.get(snapshot.id),
                suiteChangeCount: changeSummary.added + changeSummary.removed + changeSummary.updated,
            });
            return {
                ...snapshot,
                changeSummary,
                health,
                healthCounts: healthBySnapshot.get(snapshot.id)?.counts ?? {
                    failing: 0,
                    passing: 0,
                    running: 0,
                    setupFailed: 0,
                    notAffected: snapshot._count.testCaseAssignments,
                    totalTests: snapshot._count.testCaseAssignments,
                },
                bugCount,
                summary,
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

    async getSnapshotDetail(
        snapshotId: string,
        organizationId: string,
        // Defaults to the full payload so any internal caller keeps prior behavior. The tRPC router
        // opts out of the workflow/refinement-loop work for aggregate callers (e.g. the PR overview
        // card, which fans this out across every snapshot in the PR).
        options: { includeWorkflow: boolean; includeRefinementLoop: boolean } = {
            includeWorkflow: true,
            includeRefinementLoop: true,
        },
    ) {
        this.logger.info("Getting snapshot detail", { snapshotId, ...options });

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
                diffsJob: {
                    select: {
                        status: true,
                        analysisReasoning: true,
                        failureReason: true,
                        startedAt: true,
                        completedAt: true,
                        affectedTests: {
                            select: {
                                affectedReason: true,
                                reasoning: true,
                                testCase: { select: { id: true, name: true, slug: true } },
                                generation: {
                                    select: {
                                        id: true,
                                        status: true,
                                        generationReview: { select: { reasoning: true } },
                                    },
                                },
                            },
                            orderBy: { createdAt: "asc" },
                        },
                    },
                },
            },
        });

        if (snapshot == null) throw new NotFoundError("Snapshot not found");

        // An authoritative-mode snapshot has an AnalysisJob, not a DiffsJob, so it carries no diffs-pipeline metadata
        // and `diffsJob` is absent - the page reads its findings from the AnalysisReport instead. The rest of the
        // detail (changes, created tests, executed tests) is real and driven by the snapshot's assignments either way.
        const diffsJob = snapshot.diffsJob ?? undefined;

        // The workflow link is only rendered for a diffs snapshot (the authoritative layout gates it off). An
        // authoritative snapshot has no diffs job, so resolving its `diffs-analysis-{snapshotId}` workflow round-trips
        // to Temporal only to describe a workflow that does not exist and then discard the result - skip it entirely.
        const temporalWorkflowPromise: Promise<WorkflowRef | undefined> =
            options.includeWorkflow && snapshot.diffsJob != null
                ? findLatestWorkflowBySnapshotId(snapshotId).catch((error) => {
                      this.logger.warn("Could not resolve Temporal workflow for snapshot", { snapshotId, error });
                      return undefined;
                  })
                : Promise.resolve(undefined);

        const { prInfo, ...branchRest } = snapshot.branch;
        // Strip the raw diffs job off the flat snapshot; it is returned separately as `diffsJobWithMeta` (undefined
        // for an authoritative snapshot, which has none).
        const { diffsJob: _rawDiffsJob, branch: _branch, ...snapshotRest } = snapshot;
        const flatSnapshot = {
            ...snapshotRest,
            branch: { ...branchRest, prNumber: prInfo?.prNumber },
        };

        const [changes, temporalWorkflow, refinementLoop, firstIterationReasoning] = await Promise.all([
            getChangesForSnapshot(this.db, snapshotId, snapshot.prevSnapshotId, this.logger),
            temporalWorkflowPromise,
            options.includeRefinementLoop
                ? loadRefinementLoop(this.db, snapshotId, this.logger)
                : Promise.resolve(undefined),
            // The first iteration's reasoning is only rendered on the single-snapshot pipeline strip,
            // so it loads alongside the refinement loop. The lean PR-overview fan-out (one detail per
            // snapshot) leaves it out to avoid a per-snapshot query.
            options.includeRefinementLoop
                ? loadFirstIterationReasoning(this.db, snapshotId, this.logger)
                : Promise.resolve(undefined),
        ]);

        // Absent for an authoritative snapshot; the diffs-pipeline surfaces (pipeline strip, Temporal link) that read
        // it are not rendered there. `firstIterationReasoning`/`temporalWorkflow` are diffs-pipeline metadata, so they
        // ride with the job or not at all.
        const diffsJobWithMeta =
            diffsJob != null ? { ...diffsJob, firstIterationReasoning, temporalWorkflow } : undefined;

        // Created tests are the assignments added vs. the previous snapshot; resolve them
        // from the already-computed changes so a single diff drives both surfaces. The
        // generation/run inspector they carry is only rendered on the single-snapshot page,
        // so it loads alongside the refinement loop - the lean PR-overview fan-out leaves it
        // out (the overview reads added-test runs from executedTests) to avoid extra
        // per-snapshot queries.
        const createdTestCaseIds = changes.filter((c) => c.type === "added").map((c) => c.testCaseId);
        const createdTestsPromise: Promise<SnapshotCreatedTest[]> = options.includeRefinementLoop
            ? loadCreatedTests(this.db, snapshotId, createdTestCaseIds, this.logger)
            : Promise.resolve([]);

        const [executedTests, assignmentCount, createdTests, openBugCountBySnapshot] = await Promise.all([
            listExecutedTestsForSnapshot(this.db, snapshotId),
            this.db.testCaseAssignment.count({ where: { snapshotId } }),
            createdTestsPromise,
            countOpenBugsBySnapshot(this.db, [snapshotId]),
        ]);
        const counts = this.computeHealthCounts(assignmentCount, executedTests);
        const health = computeSnapshotHealth(snapshot.status, counts);

        // Attribute failing tests that carry a linked Issue to engine vs app by Issue kind. The
        // lookup no-ops (no query) when nothing failed, keeping the all-green path query-flat.
        const { generationIds } = failingExecutionIds([executedTests]);
        const issueKinds = await loadIssueKindsForExecutions(this.db, generationIds);
        const failingByKind = computeFailingByKind(executedTests, issueKinds);
        const suiteChangeCount = changes.filter(
            (c) => c.type === "added" || c.type === "updated" || c.type === "removed",
        ).length;
        // NOTE: no authoritative branch here. `snapshotDetail.summary` is fanned out per snapshot by the legacy PR
        // overview card and is never rendered on an authoritative surface (the authoritative report page reads its
        // verdict from the AnalysisReport / loadSnapshotReport header), so it stays on the cheap legacy path.
        const summary = buildCheckpointSummary({
            snapshotStatus: snapshot.status,
            counts,
            openBugCount: openBugCountBySnapshot.get(snapshotId) ?? 0,
            failingByKind,
            suiteChangeCount,
        });

        return {
            snapshot: flatSnapshot,
            changes,
            diffsJob: diffsJobWithMeta,
            createdTests,
            refinementLoop,
            health,
            healthCounts: counts,
            summary,
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
            storageProvider: this.storageProvider,
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

        let comparisonSnapshotId = branch.baseSnapshotId;
        if (comparisonSnapshotId == null) {
            this.logger.warn("Branch has no baseSnapshotId, falling back to activeSnapshot.prevSnapshotId", {
                branchId,
                activeSnapshotId: branch.activeSnapshotId,
            });
            comparisonSnapshotId = branch.activeSnapshot?.prevSnapshotId ?? null;
        }

        const testSuite = await fetchTestSuiteInfo(this.db, branch.activeSnapshotId);
        const changes = await getChangesForSnapshot(
            this.db,
            branch.activeSnapshotId,
            comparisonSnapshotId,
            this.logger,
        );

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
                    // The detached investigation twin is not part of the lineage either.
                    where: {
                        status: { not: "cancelled" },
                        investigationParent: { is: null },
                    },
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

/** A snapshot's checkpoint presentation: the badge summary, the raw health signal, and the bug count - the three
 * fields the PR list, the checkpoint rail and the PR pipeline status each render off one snapshot. */
interface CheckpointPresentation {
    summary: CheckpointPresentationSummary | undefined;
    health: SnapshotHealth;
    bugCount: number;
}

/**
 * The ONE place the legacy-vs-authoritative choice is made. An authoritative snapshot (the merged analysis pipeline
 * ran, so `authoritative` is set) derives all three fields from the AnalysisReport verdict + finding categories; a
 * legacy snapshot derives them from the health/Bug model the analysis pipeline does not populate. Every surface that
 * renders a checkpoint calls this rather than re-deriving the fork per field - so the badge, the raw `health` beside
 * it, and the `bugCount` can never disagree about which pipeline ran.
 */
function presentCheckpoint(input: {
    snapshotStatus: string;
    healthResult: SnapshotHealthResult | undefined;
    legacyBugCount: number;
    authoritative: LoadedAuthoritativeInputs | undefined;
    issueOccurrenceCount?: number;
    suiteChangeCount?: number;
}): CheckpointPresentation {
    const { snapshotStatus, healthResult, legacyBugCount, authoritative } = input;
    if (authoritative != null) {
        return {
            summary: buildAuthoritativeCheckpointSummary({
                jobStatus: authoritative.jobStatus,
                findingBuckets: authoritative.findingBuckets,
                bugCount: authoritative.bugCount,
                totalTests: healthResult?.counts.totalTests,
                suiteChangeCount: input.suiteChangeCount,
            }),
            health: authoritativeSnapshotHealth(authoritative),
            // Open bug issues (finalize persists them as clientBugCount), never `Bug` rows - the pipeline files none.
            bugCount: authoritative.bugCount ?? authoritative.findingBuckets?.bug ?? 0,
        };
    }
    return {
        summary:
            healthResult != null
                ? buildCheckpointSummary({
                      snapshotStatus,
                      counts: healthResult.counts,
                      openBugCount: legacyBugCount,
                      issueOccurrenceCount: input.issueOccurrenceCount,
                      failingByKind: healthResult.failingByKind,
                      suiteChangeCount: input.suiteChangeCount,
                  })
                : undefined,
        health: healthResult?.health ?? "unknown",
        bugCount: legacyBugCount,
    };
}

const PreviewUrlsSchema = z.record(z.string(), z.string());

function firstPreviewUrl(urls: unknown): string | undefined {
    const parsed = PreviewUrlsSchema.safeParse(urls);
    if (!parsed.success) return undefined;
    for (const url of Object.values(parsed.data)) {
        if (url.length > 0) return url;
    }
    return undefined;
}
