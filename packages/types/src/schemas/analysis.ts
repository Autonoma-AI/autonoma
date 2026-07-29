import { z } from "zod";
import { overlayPointSchema } from "../types/step-overlay-points";
import { resolvedEvidenceAssetSchema } from "./evidence-tokens";
import {
    investigationEvidenceSchema,
    investigationFindingSchema,
    investigationRunStepSchema,
} from "./investigation-report";
import { suspectedCauseSchema } from "./suspected-cause";

/** The terminal state of an authoritative analysis run. */
export type AnalysisRunOutcome =
    | { kind: "succeeded" }
    | { kind: "failed"; reason: string }
    | { kind: "superseded"; reason: string };

/**
 * The terminal verdict an Investigator emits for one test - the complete taxonomy the merged pipeline resolves
 * every run to. Two planes:
 *
 * - App-health: `client_bug` (the app misbehaved - the only true positive against the PR) and `passed`. This
 *   plane drives the PR's headline verdict.
 * - Coverage-confidence: `engine_artifact` (a harness/engine fault - flake, crash, timeout), `environment_failure`
 *   (the preview/infra was unavailable), `scenario_issue` (the test data was mis-seeded), and `plan_mismatch` (the
 *   app rendered correctly but the test's plan does not match it - self-heal could not stabilize it within budget,
 *   so it is kept for a later run rather than removed). This plane never counts as a bug against the PR and never
 *   blocks the run.
 *
 * `plan_mismatch` is both a classifier category and a terminal verdict: the classifier emits it, the Investigator
 * routes it through a self-heal plan rewrite + re-run, and when that loop exhausts on a healthy app it resolves back
 * to `plan_mismatch` - kept, never deleted. A budget-exhausted test may be salvageable in a later snapshot, or may be
 * surfacing a real defect the classifier misdiagnosed. There is deliberately no "unknown" bucket: a fault the
 * Investigator cannot classify resolves to `engine_artifact`, never to a silent drop.
 */
export const analysisVerdictSchema = z.enum([
    "passed",
    "client_bug",
    "engine_artifact",
    "environment_failure",
    "scenario_issue",
    "plan_mismatch",
]);
export type AnalysisVerdict = z.infer<typeof analysisVerdictSchema>;

export const ANALYSIS_VERDICT = analysisVerdictSchema.enum;

/**
 * How a finding is presented: the ordered tiers every findings list groups and sorts by.
 *
 * - `bug`: the only verdict that counts against the PR.
 * - `needs_review`: non-blocking, but it needs a human eye - a `plan_mismatch` the run could not stabilize may be
 *   surfacing a real defect the classifier misdiagnosed, so it is surfaced rather than collapsed with the rest.
 * - `coverage`: a non-blocking harness/infra/data fault.
 * - `passed`: the green rows.
 */
export type AnalysisFindingTier = "bug" | "needs_review" | "coverage" | "passed";

/**
 * THE partition of the verdict taxonomy - the one place a verdict's presentation is declared. Every other split
 * below (plane, bucket, sort order) derives from it, so they cannot drift from each other or from the taxonomy, and
 * no surface may re-derive a tier by testing verdict literals of its own.
 *
 * A `Record` over the `AnalysisVerdict` SSOT, so adding a verdict is a compile error here until it is given a tier.
 */
const VERDICT_TIER: Record<AnalysisVerdict, AnalysisFindingTier> = {
    client_bug: "bug",
    plan_mismatch: "needs_review",
    engine_artifact: "coverage",
    environment_failure: "coverage",
    scenario_issue: "coverage",
    passed: "passed",
};

/** Where each tier sorts: what needs action first, then what needs a look, then the remaining non-blocking rows. */
const TIER_ORDER: Record<AnalysisFindingTier, number> = { bug: 0, needs_review: 1, coverage: 2, passed: 3 };

/**
 * The tier a finding is presented in. Verdicts arrive from the store as plain strings, so an unknown value falls back
 * to `coverage` - never actionable, never blocking - matching the UI's graceful fallback.
 */
export function analysisFindingTier(category: string): AnalysisFindingTier {
    const parsed = analysisVerdictSchema.safeParse(category);
    return parsed.success ? VERDICT_TIER[parsed.data] : "coverage";
}

/**
 * The two planes the verdict taxonomy splits into. `app_health` is the only plane that counts against the PR;
 * `coverage` is the coverage-confidence plane (never a bug, never blocking).
 */
export type AnalysisVerdictPlane = "app_health" | "coverage";

/**
 * The plane a verdict falls on, derived from its tier: the app-health plane is exactly the tiers that speak to the
 * app's behavior (a bug, or a pass), and everything else is coverage-confidence.
 */
export function analysisVerdictPlane(category: string): AnalysisVerdictPlane {
    const tier = analysisFindingTier(category);
    return tier === "bug" || tier === "passed" ? "app_health" : "coverage";
}

/** The coverage-plane verdicts, derived from the partition over the schema's option list (never hand-listed). */
export const coverageVerdicts: AnalysisVerdict[] = analysisVerdictSchema.options.filter(
    (verdict) => analysisVerdictPlane(verdict) === "coverage",
);

/**
 * The bucket a finding is COUNTED in - the three the checkpoint reports. Coarser than the tier on purpose:
 * `needs_review` is non-blocking, so it counts as coverage even though it is presented on its own.
 */
export type AnalysisFindingBucket = "bug" | "passed" | "coverage";

export function analysisFindingBucket(category: string): AnalysisFindingBucket {
    const tier = analysisFindingTier(category);
    if (tier === "bug" || tier === "passed") return tier;
    return "coverage";
}

/**
 * Sort key for a finding, by the presentation tier of its terminal verdict `category`. THE ordering for every
 * findings list - the report page, the snapshot's suite-changes sections, and the Reporter's own prompt - so a
 * reader never meets the same findings in two different orders. It is a pure function of the verdict, which is why
 * no row stores it.
 *
 * Equal for every finding in the same tier, so a caller that needs a stable list must order its query too.
 */
export function analysisFindingSortKey(category: string): number {
    return TIER_ORDER[analysisFindingTier(category)];
}

/** How many findings fall in each presentation bucket. */
export interface AnalysisFindingBucketCounts {
    bug: number;
    passed: number;
    coverage: number;
}

/** Tally findings (by their terminal verdict `category`) into the three presentation buckets. */
export function countAnalysisFindingBuckets(categories: Iterable<string>): AnalysisFindingBucketCounts {
    const counts: AnalysisFindingBucketCounts = { bug: 0, passed: 0, coverage: 0 };
    for (const category of categories) counts[analysisFindingBucket(category)] += 1;
    return counts;
}

/**
 * How a test entered the analysis run:
 *
 * - `pre_existing`: an affected test the PR's diff touched (Impact Analysis marked it via `RegenerateSteps`). Its
 *   global TestCase is a real suite member.
 * - `proposed`: a brand-new test Impact Analysis authored this run for functionality the PR adds (via `AddTest`).
 *
 * Narration only: it lets the report tell a proposed test the run could not establish apart from a pre-existing one,
 * without a separate verdict for each.
 */
export const analysisTestOriginSchema = z.enum(["pre_existing", "proposed"]);
export type AnalysisTestOrigin = z.infer<typeof analysisTestOriginSchema>;

/** How many findings carry a given coverage-plane category (categories with zero are omitted). */
export const coverageCategoryCountSchema = z.object({
    category: analysisVerdictSchema,
    count: z.number().int().nonnegative(),
});
export type CoverageCategoryCount = z.infer<typeof coverageCategoryCountSchema>;

/**
 * The coverage-confidence plane of a run, summarized: `byCategory` counts the findings per coverage category (one
 * per test) plus the plane total. This is the shape `summarizeVerdictPlanes`
 * derives, persists onto `AnalysisReport.coverage` (a JSON blob), and the PR comment / UI read back - so it lives
 * here as the single source of truth, validated at the read boundary.
 */
export const coverageSummarySchema = z.object({
    byCategory: z.array(coverageCategoryCountSchema),
    /** Total findings on the coverage plane. */
    total: z.number().int().nonnegative(),
});
export type CoverageSummary = z.infer<typeof coverageSummarySchema>;

/**
 * The rich evidence one classification carries - the classifier's full output (`classifyInvestigationRun`) for the
 * generation it judged. It rides on every candidate classification (optional: a contained scenario/classify fault
 * has no classifier output at all) so the Investigator can persist it onto an `AnalysisClassification` row. Media
 * are stored as `s3://` keys (signed on read), never raw URLs.
 */
export const analysisClassificationReportSchema = z.object({
    confidence: z.string().optional(),
    /** What the app SHOULD have done / what it actually did - the app-health plane's behavior claim (`passed` and
     * `client_bug` only). */
    expectedBehavior: z.string().optional(),
    actualBehavior: z.string().optional(),
    /** Free-form "what happened" narrative - the coverage plane's analog of expected/actual: `engine_artifact`,
     * `environment_failure`, and `scenario_issue` carry it (also holds rows written before the expected/actual split). */
    whatHappened: z.string().optional(),
    /** The `plan_mismatch` self-heal post-mortem: what the test asserted that was wrong, the rewrite attempted, and
     * why it still failed. Set only for a `plan_mismatch` verdict. */
    planMismatchNote: z.string().optional(),
    rootCause: z.string().optional(),
    remediation: z.string().optional(),
    /** App problems seen in the run independent of this test's pass/fail. */
    observedAppIssues: z.string().optional(),
    /** The classifier's explicit false-positive self-check. */
    falsePositiveRisk: z.string().optional(),
    /** The test plan the run was checked against (the "reproduction" steps). */
    plan: z.string().optional(),
    runSuccess: z.boolean().optional(),
    stepCount: z.number().optional(),
    /** The run agent's per-step text trace (interaction + status + per-step error). */
    runSteps: z.array(z.string()).optional(),
    /** The structured, inspectable trace: per-step frame (`s3://` key) + click coords. */
    runTrace: z.array(investigationRunStepSchema).optional(),
    evidence: z.array(investigationEvidenceSchema).optional(),
    /** `s3://` media keys, signed on read. */
    videoKey: z.string().optional(),
    /** `s3://` key of the dead-time-stripped mp4 recording, signed on read. Backs the finding page's
     *  Optimized/Original toggle; absent for runs recorded before the optimizer landed. */
    optimizedVideoKey: z.string().optional(),
    screenshotKey: z.string().optional(),
    /** Short GIF clip of the failure (client bugs only), signed on read. */
    clipKey: z.string().optional(),
    /** `s3://` URL of the classifier's persisted LLM conversation (the reasoning behind this verdict), signed on
     * read. Best-effort: absent when the conversation upload failed. */
    conversationUrl: z.string().optional(),
    /** Present instead of the verdict fields when the model failed to classify this test. */
    error: z.string().optional(),
});
export type AnalysisClassificationReport = z.infer<typeof analysisClassificationReportSchema>;

/**
 * One entry of a finding's self-heal history as the finding page consumes it: enough to say what this iteration
 * concluded and to reach both artifacts behind it - the classifier's reasoning and the run it judged. The full
 * evidence stays on the finding's CURRENT classification; a superseded iteration is an audit record, not a second
 * finding page.
 */
export const analysisClassificationSummarySchema = z.object({
    id: z.string(),
    /** 1-based iteration of the Investigator's self-heal loop. */
    number: z.number(),
    /** The generation this iteration ran and judged - links to that run's own page (video, steps, trace). */
    generationId: z.string(),
    /** The verdict this iteration reached - a member of `AnalysisVerdict` (a superseded self-heal iteration carries
     * `plan_mismatch`, the same terminal it routes to). Kept a plain string so a stored value outside the current
     * taxonomy still renders as a plain label rather than throwing. */
    category: z.string(),
    headline: z.string(),
    createdAt: z.date(),
    /** Browser-openable URL of this iteration's classifier conversation (the API signs the stored key on read). */
    conversationUrl: z.string().optional(),
});
export type AnalysisClassificationSummary = z.infer<typeof analysisClassificationSummarySchema>;

/**
 * One `AnalysisFinding` as the snapshot page consumes it: the finding's own per-test facts, its CURRENT
 * classification flattened into the `investigationFindingSchema` display shape (so the findings list and evidence
 * detail render it with the same components), and the self-heal history behind it.
 *
 * Two fields read differently here than the base shape's doc describes: `id` is the finding's own id (the frozen
 * investigation twin routes on a slug; this pipeline does not), and `coveredSlugs` is omitted entirely - findings
 * are never merged here, so the column is gone and any reader still branching on it is reading a fiction.
 */
export const analysisFindingViewSchema = investigationFindingSchema.omit({ coveredSlugs: true }).extend({
    /** The generation the CURRENT classification judged - after a self-heal, the last one the Investigator ran. */
    generationId: z.string(),
    /** The test this finding is about. */
    testCase: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
    /** How the test entered the run: an affected suite member (`pre_existing`) or authored this run (`proposed`). */
    origin: analysisTestOriginSchema.optional(),
    /** Why Impact Analysis selected this test to investigate. */
    selectionReason: z.string().optional(),
    /**
     * Every classification of this test in this run, oldest first, INCLUDING the current one (always the last).
     * More than one means the Investigator self-healed: each earlier entry is the verdict that authored the
     * rewrite which followed it, with its own reasoning still reachable.
     */
    classifications: z.array(analysisClassificationSummarySchema),
});
export type AnalysisFindingView = z.infer<typeof analysisFindingViewSchema>;

/**
 * The authoritative analysis report as the snapshot page consumes it: the merged pipeline's per-run
 * `AnalysisReport` header plus its `AnalysisFinding` children, re-signed for display. `category` is the terminal
 * `AnalysisVerdict` as a plain string - the UI maps the known verdicts to styles and falls back gracefully,
 * matching the investigation display contract.
 *
 * The presence of this report (non-null) is the page-level gate: a snapshot with one renders the authoritative
 * layout, otherwise the diffs UI is left untouched.
 */
export const analysisReportDataSchema = z.object({
    /**
     * The branch the report's snapshot belongs to. Issues are branch-scoped, so the per-job view needs this to read
     * the branch's issue set - which is what lets an `issue:` token in the (PR-cumulative) prose resolve even when
     * the issue has no finding in THIS run.
     */
    branchId: z.string(),
    /** The Impact Analysis stage's account of why it selected the tests it did (admin-only on the snapshot page). */
    impactReasoning: z.string().optional(),
    /**
     * The Reporter's holistic PR report prose (Markdown), the hero of the PR page and the snapshot per-job view.
     * Absent while a run is still authoring it (the page keeps polling) or when the run degraded to a
     * finding-derived verdict with no prose. Its inline `evidence:` image tokens resolve against `reportEvidence`;
     * `issue:`/`finding:` link tokens resolve against the branch's issues and this report's findings.
     */
    reportMarkdown: z.string().optional(),
    /**
     * The Reporter's one-paragraph summary of the run, for the surfaces that show prose but not a document: the PR
     * page's verdict subtitle. Absent on a run that predates the Reporter (those rows were backfilled to empty).
     */
    summary: z.string().optional(),
    /** The signed assets `reportMarkdown` may embed inline by `evidence:<assetId>` token (referenced ones only). */
    reportEvidence: z.array(resolvedEvidenceAssetSchema),
    /** The persisted app-health verdict for the run (issue-derived at finalize): `client_bug` or `passed`. */
    verdict: analysisVerdictSchema,
    /** The run's open-bug count (issue-derived) and total investigated tests, for the per-job header. */
    clientBugCount: z.number().int().nonnegative(),
    testCount: z.number().int().nonnegative(),
    findings: z.array(analysisFindingViewSchema),
});
export type AnalysisReportData = z.infer<typeof analysisReportDataSchema>;

/**
 * A branch/PR-scoped issue's class, severity, and lifecycle - the single source of truth the Reporter (writer),
 * the API read path, and the UI display metadata all validate against. Enum-shaped columns are stored as plain
 * strings on `AnalysisIssue` (matching the analysis island) and parsed at each boundary; a row that fails to
 * parse is skipped, never surfaced malformed.
 */
export const analysisIssueKindSchema = z.enum(["bug", "environment", "scenario"]);
export type AnalysisIssueKind = z.infer<typeof analysisIssueKindSchema>;

export const analysisIssueSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type AnalysisIssueSeverity = z.infer<typeof analysisIssueSeveritySchema>;

export const analysisIssueStatusSchema = z.enum(["open", "resolved"]);
export type AnalysisIssueStatus = z.infer<typeof analysisIssueStatusSchema>;

/** Severity ordering (most-severe first), keyed over the SSOT so a new severity is a compile error until ranked. */
const ANALYSIS_ISSUE_SEVERITY_RANK: Record<AnalysisIssueSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
};

/**
 * The list ordering for the open-issues surfaces (PR page + PR comment): bugs first (the only app-health class),
 * then by descending severity within each class. A single helper so every list agrees on the order.
 */
export function compareAnalysisIssues(
    a: { kind: AnalysisIssueKind; severity: AnalysisIssueSeverity },
    b: { kind: AnalysisIssueKind; severity: AnalysisIssueSeverity },
): number {
    const aBug = a.kind === "bug" ? 0 : 1;
    const bBug = b.kind === "bug" ? 0 : 1;
    if (aBug !== bBug) return aBug - bBug;
    return ANALYSIS_ISSUE_SEVERITY_RANK[a.severity] - ANALYSIS_ISSUE_SEVERITY_RANK[b.severity];
}

/** A screenshot resolved into a signed hero (URL + overlay pins), how the API serves a `PrimaryScreenshot`. */
export const resolvedPrimaryScreenshotSchema = z.object({
    url: z.string(),
    points: z.array(overlayPointSchema),
});
export type ResolvedPrimaryScreenshot = z.infer<typeof resolvedPrimaryScreenshotSchema>;

/**
 * One branch-scoped issue as the open-issues list (PR page) and the per-job issue-set changes (snapshot page)
 * render it: the header fields plus an optional signed thumbnail and the number of runs it has recurred across.
 * The full narrative/evidence lives on the detail read.
 */
export const analysisIssueSummarySchema = z.object({
    id: z.string(),
    title: z.string(),
    kind: analysisIssueKindSchema,
    severity: analysisIssueSeveritySchema,
    status: analysisIssueStatusSchema,
    /** Signed thumbnail from the issue's designated primary screenshot, when it has one. */
    thumbnailUrl: z.string().optional(),
    /** How many distinct runs (snapshots) this issue has been attributed to - its recurrence across the branch.
     * Counts distinct snapshots, not finding rows: one run can attribute several findings to the same issue. */
    runCount: z.number().int().nonnegative(),
});
export type AnalysisIssueSummary = z.infer<typeof analysisIssueSummarySchema>;

/**
 * One of an issue's finding instances, resolved for the issue-detail page's cross-snapshot timeline: which
 * snapshot surfaced it (with its head sha + time) and the finding-detail routing id, so the row links to the
 * per-snapshot finding page.
 */
export const analysisIssueFindingInstanceSchema = z.object({
    snapshotId: z.string(),
    snapshotCreatedAt: z.date(),
    headSha: z.string().optional(),
    /** The stable per-report routing id the finding-detail page is keyed on. */
    findingId: z.string(),
    slug: z.string(),
    category: z.string(),
    headline: z.string(),
});
export type AnalysisIssueFindingInstance = z.infer<typeof analysisIssueFindingInstanceSchema>;

/**
 * The full issue-detail read: the header, the grounded narrative (with its signed evidence + hero + suspected
 * cause), and every finding instance the issue covers across the branch's snapshots. `evidence` resolves the
 * narrative's `evidence:` tokens; a token with no resolved asset renders as nothing.
 */
export const analysisIssueDetailSchema = z.object({
    id: z.string(),
    title: z.string(),
    kind: analysisIssueKindSchema,
    severity: analysisIssueSeveritySchema,
    status: analysisIssueStatusSchema,
    expectedBehavior: z.string().optional(),
    actualBehavior: z.string(),
    narrativeMarkdown: z.string(),
    evidence: z.array(resolvedEvidenceAssetSchema),
    suspectedCause: suspectedCauseSchema.optional(),
    primaryScreenshot: resolvedPrimaryScreenshotSchema.optional(),
    resolvedAt: z.date().optional(),
    findingInstances: z.array(analysisIssueFindingInstanceSchema),
});
export type AnalysisIssueDetail = z.infer<typeof analysisIssueDetailSchema>;

/**
 * The per-job issue-set changes the snapshot page shows: which branch issues this run opened, carried forward
 * from an earlier run, or resolved. Derived from the run's `AnalysisJob` window and the findings it attributed.
 */
export const analysisSnapshotIssueChangesSchema = z.object({
    opened: z.array(analysisIssueSummarySchema),
    carriedForward: z.array(analysisIssueSummarySchema),
    resolved: z.array(analysisIssueSummarySchema),
});
export type AnalysisSnapshotIssueChanges = z.infer<typeof analysisSnapshotIssueChangesSchema>;
