import { z } from "zod";
import { overlayPointSchema } from "../types/step-overlay-points";
import { resolvedEvidenceAssetSchema } from "./evidence-tokens";
import {
    investigationEvidenceSchema,
    investigationFindingSchema,
    investigationRunStepSchema,
} from "./investigation-report";
import { suspectedCauseSchema } from "./suspected-cause";

/**
 * The terminal verdict an Investigator emits for one test - the complete taxonomy the merged pipeline resolves
 * every run to. Two planes:
 *
 * - App-health: `client_bug` (the app misbehaved - the only true positive against the PR) and `passed`. This
 *   plane drives the PR's headline verdict.
 * - Coverage-confidence: `engine_artifact` (a harness/engine fault - flake, crash, timeout), `environment_failure`
 *   (the preview/infra was unavailable), `scenario_issue` (the test data was mis-seeded), and `delete` (a
 *   correct app whose test could not be stabilized, so the Investigator deleted its own row). This plane never
 *   counts as a bug against the PR and never blocks the run.
 *
 * `delete` is not a classifier output: the Investigator resolves it when a `test_is_wrong` self-heal loop
 * exhausts on a healthy app (the final iteration disallows another rewrite). ONE terminal covers both an
 * un-fixable affected test and an un-stabilizable new test - the report tells them apart from data (was the
 * plan pinned by the snapshot or authored this run), not a separate verdict. There is deliberately no "unknown"
 * bucket: a fault the Investigator cannot classify resolves to `engine_artifact`, never to a silent drop.
 *
 * `test_is_wrong` (the old `outdated_test` + `bad_test`, collapsed) is intentionally absent - it is a TRANSIENT
 * loop-routing signal inside the Investigator, never emitted as a finding.
 */
export const analysisVerdictSchema = z.enum([
    "passed",
    "client_bug",
    "engine_artifact",
    "environment_failure",
    "scenario_issue",
    "delete",
]);
export type AnalysisVerdict = z.infer<typeof analysisVerdictSchema>;

export const ANALYSIS_VERDICT = analysisVerdictSchema.enum;

/**
 * The two planes the verdict taxonomy splits into. `app_health` is the only plane that counts against the PR;
 * `coverage` is the coverage-confidence plane (never a bug, never blocking).
 */
export type AnalysisVerdictPlane = "app_health" | "coverage";

/**
 * The single source of truth for the plane partition of the verdict taxonomy, derived from every surface that
 * needs it (the Reconciler coverage summary, the PR verdict headline, the checkpoint rail). A `Record` over the
 * `AnalysisVerdict` SSOT, so adding a verdict is a compile error here until it is assigned a plane - a plane can
 * never silently omit a verdict or count one twice.
 */
const VERDICT_PLANE: Record<AnalysisVerdict, AnalysisVerdictPlane> = {
    client_bug: "app_health",
    passed: "app_health",
    engine_artifact: "coverage",
    environment_failure: "coverage",
    scenario_issue: "coverage",
    delete: "coverage",
};

/** The coverage-plane verdicts, derived from the partition over the schema's option list (never hand-listed). */
export const coverageVerdicts: AnalysisVerdict[] = analysisVerdictSchema.options.filter(
    (verdict) => VERDICT_PLANE[verdict] === "coverage",
);

/**
 * The plane a verdict falls on. Verdicts arrive from the store as plain strings, so an unknown value falls back
 * to `coverage` - it never counts against the PR - matching the UI's graceful fallback.
 */
export function analysisVerdictPlane(category: string): AnalysisVerdictPlane {
    const parsed = analysisVerdictSchema.safeParse(category);
    return parsed.success ? VERDICT_PLANE[parsed.data] : "coverage";
}

/**
 * The presentation bucket a finding falls in: a client bug (the only verdict that counts against the PR), a
 * passed app-health check, or a non-blocking coverage-plane check. Derived from the plane partition plus the
 * single actionable verdict, so it can never drift from the taxonomy.
 */
export type AnalysisFindingBucket = "bug" | "passed" | "coverage";

export function analysisFindingBucket(category: string): AnalysisFindingBucket {
    if (analysisVerdictPlane(category) === "coverage") return "coverage";
    return category === analysisVerdictSchema.enum.client_bug ? "bug" : "passed";
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
 * How a test entered the analysis run - the data tag that tells a `delete` finding apart:
 *
 * - `pre_existing`: an affected test the PR's diff touched (Impact Analysis marked it via `RegenerateSteps`). Its
 *   global TestCase is a real suite member, so a `delete` removes only this run's assignment.
 * - `proposed`: a brand-new test Impact Analysis authored this run for functionality the PR adds (via `AddTest`).
 *   Its TestCase exists only for this run, so a `delete` removes the whole TestCase, not just the assignment.
 *
 * Carried onto every candidate finding so the report can narrate the two apart ("couldn't establish N proposed
 * tests" vs "removed N obsolete tests") and so the Investigator's self-delete cleans up the right rows.
 */
export const analysisTestOriginSchema = z.enum(["pre_existing", "proposed"]);
export type AnalysisTestOrigin = z.infer<typeof analysisTestOriginSchema>;

/** How many deduped findings carry a given coverage-plane category (categories with zero are omitted). */
export const coverageCategoryCountSchema = z.object({
    category: analysisVerdictSchema,
    count: z.number().int().nonnegative(),
});
export type CoverageCategoryCount = z.infer<typeof coverageCategoryCountSchema>;

/**
 * The coverage-confidence plane of a run, summarized. `byCategory` counts the DEDUPED findings per coverage
 * category (one distinct issue counted once); the delete split counts individual TESTS (finding members) so a
 * merged `delete` group still reports every test it could not establish or removed. This is the shape the
 * Reconciler derives (`summarizeVerdictPlanes`), persists onto `AnalysisReport.coverage` (a JSON blob), and the
 * PR comment / UI read back - so it lives here as the single source of truth, validated at the read boundary.
 */
export const coverageSummarySchema = z.object({
    byCategory: z.array(coverageCategoryCountSchema),
    /** Total deduped findings on the coverage plane. */
    total: z.number().int().nonnegative(),
    /** delete tests that were proposed this run and could not be established (member-level, by origin). */
    unestablishedProposed: z.number().int().nonnegative(),
    /** delete tests that pre-existed and were removed as obsolete (member-level, by origin). */
    obsoleteRemoved: z.number().int().nonnegative(),
});
export type CoverageSummary = z.infer<typeof coverageSummarySchema>;

/**
 * The rich per-test evidence an Investigator captures when it classifies a run - the classifier's full output
 * (`classifyInvestigationRun`) that the merged pipeline used to collapse to a 5-field candidate and discard. It
 * rides on every candidate finding (optional: a contained scenario/classify fault or a crashed Investigator has
 * no classifier output) so the Reconciler can persist it onto an `AnalysisFinding` row, mirroring the frozen
 * `InvestigationFinding`. Media are stored as `s3://` keys (signed on read), never raw URLs.
 */
export const analysisFindingReportSchema = z.object({
    confidence: z.string().optional(),
    /** What the app SHOULD have done / what it actually did - the classifier's per-category behavior fields. */
    expectedBehavior: z.string().optional(),
    actualBehavior: z.string().optional(),
    /** Legacy free-form narrative fields (frozen investigation twin); the analysis path uses expected/actual. */
    whatHappened: z.string().optional(),
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
    classificationConversationUrl: z.string().optional(),
    /** Present instead of the verdict fields when the model failed to classify this test. */
    error: z.string().optional(),
});
export type AnalysisFindingReport = z.infer<typeof analysisFindingReportSchema>;

/**
 * The authoritative analysis report as the snapshot page consumes it: the merged pipeline's per-run
 * `AnalysisReport` header plus its `AnalysisFinding` children, re-signed for display. The findings reuse the
 * `investigationFindingSchema` display shape so the snapshot page renders them with the same findings-list and
 * evidence-detail components (repointed at the analysis store); the analysis-only signals (`planEdited`, origin,
 * clip) are not surfaced here. `category` is the terminal `AnalysisVerdict` as a plain string - the UI maps the
 * known verdicts to styles and falls back gracefully, matching the investigation display contract.
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
    findings: z.array(investigationFindingSchema),
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
