import { z } from "zod";
import { MAIN_BRANCH_ENVIRONMENT_NUMBER } from "../types/previewkit";
import { overlayPointSchema } from "../types/step-overlay-points";
import { resolvedEvidenceAssetSchema } from "./evidence-tokens";
import {
    investigationEvidenceSchema,
    investigationFindingSchema,
    investigationRunStepSchema,
} from "./investigation-report";
import { suspectedCauseSchema } from "./suspected-cause";

/**
 * What an analysis run is analyzing: a pull request under review, or the application's own main branch.
 *
 * Both run the SAME pipeline over the same suite against the same kind of live preview - the kind is never a
 * reason to compute something different. It exists because the two carry different FACTS: a PR has a number and
 * an author's stated intent; main has a branch name and no author to quote, because its change is N merged PRs
 * by N people. Read it only where a GitHub surface genuinely does not exist for a branch push (there is no
 * comment target and no merge to gate), or where one of those facts is genuinely absent. A `kind` check inside
 * Impact Analysis, an Investigator, or the Reporter's reconciliation is a bug.
 *
 * Resolved from the run's snapshot (its branch), never from a sentinel PR number: "no PR" and "skip this effect"
 * are two different facts and a single number cannot carry both.
 */
export type AnalysisRunTarget =
    | { kind: "pull_request"; prNumber: number; prTitle?: string; prBody?: string }
    | { kind: "main_branch"; branchName: string };

/**
 * The previewkit environment number a run's preview lives under. A PR run's preview is its PR's environment; a main
 * run's is the long-lived main-branch environment, which exists and carries the same app logs, script harness and
 * preview env a PR run introspects.
 */
export function previewEnvironmentNumber(target: AnalysisRunTarget): number {
    return target.kind === "pull_request" ? target.prNumber : MAIN_BRANCH_ENVIRONMENT_NUMBER;
}

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
 *   (the preview/infra was unavailable), `scenario_issue` (the test data was mis-seeded), `plan_mismatch` (the
 *   app rendered correctly but the test's plan does not match it - self-heal could not stabilize it within budget,
 *   so it is KEPT for a later run rather than removed), and `invalid_test` (the test is irreparably broken - it
 *   covers something that cannot exist, has structurally unexecutable steps, or a premise the app contradicts - so
 *   it is REMOVED). This plane never counts as a bug against the PR and never blocks the run.
 *
 * `plan_mismatch` and `invalid_test` split the "the test is wrong" space along recoverability: `plan_mismatch` is
 * salvageable (keep), `invalid_test` is irreparable (remove). `plan_mismatch` is both a classifier category and a
 * terminal verdict: the classifier emits it, the Investigator routes it through a self-heal plan rewrite + re-run,
 * and when that loop exhausts on a healthy app it resolves back to `plan_mismatch` - kept, never deleted. A
 * budget-exhausted test may be salvageable in a later snapshot, or may be surfacing a real defect the classifier
 * misdiagnosed. `invalid_test` is the high-confidence, affirmative counterpart: the classifier must justify it with
 * evidence of impossibility, and the Investigator removes the test's assignment (its `TestCase` + classification
 * record are preserved). There is deliberately no "unknown" bucket: a fault the
 * Investigator cannot classify resolves to `engine_artifact`, never to a silent drop.
 */
export const analysisVerdictSchema = z.enum([
    "passed",
    "client_bug",
    "engine_artifact",
    "environment_failure",
    "scenario_issue",
    "plan_mismatch",
    "invalid_test",
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
    // A deliberate, evidence-backed removal - non-blocking coverage, collapsed with the other faults rather than
    // surfaced like a kept `plan_mismatch` (that tier is for tests that MIGHT be catching a real defect and need a
    // human eye; an `invalid_test` is a high-confidence call, not a question).
    invalid_test: "coverage",
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
 * Which side must act on a coverage-plane gap. Fault never moves the PR's top-line verdict (that stays purely
 * confidence-driven), so this decides only WHERE a gap is reported: what only the reader can fix is asked of them,
 * and what is ours is reported without asking anything of them.
 *
 * - `client`: their test data or their preview configuration - a mis-seeded scenario, a missing feature flag, SDK
 *   key, or migration. It blocks every future run on the branch until it is fixed, not just the current one.
 * - `autonoma`: our harness or our infrastructure.
 * - `undecided`: `environment_failure` only. A preview we could not exercise can be either side, and the taxonomy
 *   deliberately carries no owner field for it - the Reporter resolves it per finding from what happened, and the
 *   caller places it from that.
 * - `none`: nothing for anyone to chase - an `invalid_test` is a deliberate, evidence-backed removal, and the
 *   app-health verdicts are not coverage gaps at all.
 */
export type AnalysisCoverageOwner = "client" | "autonoma" | "undecided" | "none";

/** A `Record` over the verdict SSOT, so a new verdict is a compile error here until it is given an owner. */
const COVERAGE_OWNER: Record<AnalysisVerdict, AnalysisCoverageOwner> = {
    scenario_issue: "client",
    environment_failure: "undecided",
    engine_artifact: "autonoma",
    plan_mismatch: "autonoma",
    invalid_test: "none",
    client_bug: "none",
    passed: "none",
};

/** The side that must act on a coverage gap. An unknown stored value is nobody's to chase, so it reads `none`. */
export function analysisCoverageOwner(category: string): AnalysisCoverageOwner {
    const parsed = analysisVerdictSchema.safeParse(category);
    return parsed.success ? COVERAGE_OWNER[parsed.data] : "none";
}

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
 * The PR-level verdict a completed analysis run resolves to - the ONE deterministic classification every surface
 * (the GitHub comment, the merge-gate check-run, and the UI checkpoint badge) renders, so they can never disagree.
 * Computed purely from counts, never by a model.
 *
 * - `bug_found`: at least one open bug issue - the only class that counts against the PR.
 * - `not_confirmed`: no bug, but at least one coverage-plane gap. "No bug" is not "verified": a gap is a gap
 *   regardless of fault (a scenario the client must fix, or a harness flake that is on us), so it downgrades the
 *   headline either way - ownership is a body concern, not a colour one.
 * - `no_tests_needed`: nothing produced a verdict, which means Impact Analysis marked no existing test affected and
 *   authored no new one - a judgement from the stage that owns both impact analysis and gap detection, not a missing
 *   result. That reading depends on the Reporter refusing to write a report when the run queued more tests than
 *   reached a verdict; without that guard an empty run would be an absence, and this would be a false green.
 * - `healthy`: tests ran and every one confirmed the app, with zero coverage gaps.
 */
export type AnalysisVerdictState = "bug_found" | "not_confirmed" | "no_tests_needed" | "healthy";

/** The counts the PR verdict is a pure function of. */
export interface AnalysisVerdictCounts {
    /** Open bug-kind issues on the branch - the app-health signal that blocks the PR. */
    bugCount: number;
    /** Coverage-plane findings, `invalid_test` included. */
    coverageGapCount: number;
    /** Tests that produced a terminal verdict this run; zero means the run decided none were needed. */
    investigatedCount: number;
}

/** Classify a completed run's counts into the single PR verdict every surface renders. */
export function deriveAnalysisVerdict(counts: AnalysisVerdictCounts): AnalysisVerdictState {
    if (counts.bugCount > 0) return "bug_found";
    if (counts.investigatedCount === 0) return "no_tests_needed";
    if (counts.coverageGapCount > 0) return "not_confirmed";
    return "healthy";
}

/** The short badge word for a verdict: the GitHub comment's state label and the check-run/UI badge copy. */
export function analysisVerdictLabel(state: AnalysisVerdictState): string {
    switch (state) {
        case "bug_found":
            return "BUG FOUND";
        case "not_confirmed":
            return "NOT CONFIRMED";
        case "no_tests_needed":
            return "NO TESTS NEEDED";
        case "healthy":
            return "HEALTHY";
    }
}

/**
 * The deterministic one-sentence headline a run leads with - the copy the GitHub comment renders under the state
 * label and the UI verdict subtitle can reuse, so the wording never drifts between surfaces. It states what we
 * learned about the change.
 *
 * The `no_tests_needed` headline states OUR decision and nothing about the reader's codebase: a change we decline to
 * cover is regularly a user-facing one we judged already covered elsewhere, so this may never claim the change does
 * not touch the UI. Why we decided it is the Reporter's paragraph to write, not a count's to guess.
 */
export function analysisVerdictHeadline(counts: AnalysisVerdictCounts): string {
    switch (deriveAnalysisVerdict(counts)) {
        case "bug_found":
            return `Autonoma found ${counts.bugCount} ${counts.bugCount === 1 ? "bug" : "bugs"} in this PR.`;
        case "not_confirmed":
            return `Autonoma couldn't confirm this change - ${counts.coverageGapCount} ${counts.coverageGapCount === 1 ? "check" : "checks"} didn't complete.`;
        case "no_tests_needed":
            return "No tests needed for this change.";
        case "healthy":
            return "Autonoma verified this change - the app held up.";
    }
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

/**
 * The selection reason the classifier is given on a self-heal re-run, in place of the reason Impact Analysis
 * recorded for the test.
 *
 * Never persisted - the finding keeps the ORIGINAL selection reason - so anything reconstructing what a
 * re-run's classification was told has to reproduce this exact prose, which is why it is shared rather than
 * inlined at the one place that emits it.
 */
export const SELF_HEAL_RERUN_REASON =
    "Re-running after a self-heal plan rewrite: the prior run indicated a stale/incorrect test on a healthy app.";

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
    /** The `invalid_test` justification: which impossibility failure mode (nonexistent feature / unexecutable steps /
     * wrong premise / unrecoverable) and the proof. Set only for an `invalid_test` verdict. */
    invalidTestNote: z.string().optional(),
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
 * One test an issue covers, with Impact Analysis's own account of why the run exercised it. The issue is the unit a
 * reader acts on; this is the "what was actually checked, and why" underneath it, so an agent can tell an issue found
 * by a test the PR touched apart from one found by a test the run authored for new functionality.
 */
export const analysisPrCoveredTestSchema = z.object({
    slug: z.string(),
    origin: analysisTestOriginSchema.optional(),
    /** Impact Analysis's reason for selecting this test for the run. */
    selectionReason: z.string().optional(),
    /** The test's terminal verdict in the run that attributed it here. A plain string, so a stored value outside the
     * current taxonomy still reads as a label instead of failing the payload. */
    category: z.string(),
});
export type AnalysisPrCoveredTest = z.infer<typeof analysisPrCoveredTestSchema>;

/**
 * One open issue as a coding agent consumes it: the behavior claim, the grounded code-level cause, the media that
 * proves it, and where to read more. Deliberately NOT the UI's issue shape - `narrativeMarkdown` is omitted because
 * its `evidence:`/`issue:` tokens only resolve inside the app's renderer, and the cross-snapshot finding timeline is
 * omitted because it is a browsing affordance, not something a fix depends on.
 */
export const analysisPrIssueSchema = z.object({
    id: z.string(),
    title: z.string(),
    /** What kind of failure this is, which decides WHERE the fix lives: a `bug` is fixed in the repo, while
     * `environment` and `scenario` are fixed in Autonoma (secrets/preview config, and scenario recipes). */
    kind: analysisIssueKindSchema,
    severity: analysisIssueSeveritySchema,
    expectedBehavior: z.string().optional(),
    actualBehavior: z.string(),
    /** The grounded diagnosis: how the referenced code produces the symptom, with file:line references and the
     * verbatim lines that were read. A lead to confirm, never a verdict. */
    suspectedCause: suspectedCauseSchema.optional(),
    /** Short-lived signed URL of the issue's hero frame. */
    screenshotUrl: z.string().optional(),
    /** Short-lived signed URL of an animated clip of the designated reproduction, when the run captured one. */
    clipUrl: z.string().optional(),
    /** Distinct runs this issue has been attributed to - its recurrence across the branch. */
    runCount: z.number().int().nonnegative(),
    /** The issue's detail page (login required). */
    issueUrl: z.string(),
    /** The run designated as the clearest reproduction (login required). Absent when none was resolved. */
    replayUrl: z.string().optional(),
    coveredTests: z.array(analysisPrCoveredTestSchema),
});
export type AnalysisPrIssue = z.infer<typeof analysisPrIssueSchema>;

/**
 * A newer run that started after the run this payload reports, when that newer run has not produced a report yet.
 * Its presence is a caveat on everything else: `running` means the issue set may shift under the reader, `failed`
 * means the newest attempt did not land, so what follows describes the previous one.
 */
export const analysisPrNewerRunSchema = z.object({
    status: z.enum(["running", "failed"]),
    failureReason: z.string().optional(),
});
export type AnalysisPrNewerRun = z.infer<typeof analysisPrNewerRunSchema>;

/**
 * The analysis of one pull request, keyed by PR rather than by snapshot - the shape the MCP `get_analysis` tool
 * serves to a coding agent.
 *
 * The four states exist so an empty issue list is never ambiguous. Collapsing them would let an agent report "nothing
 * to fix" while a run is still in flight, or while the PR is simply on a pipeline this payload does not describe:
 *
 * - `no_analysis`: no analysis run exists for this PR (it may predate the pipeline).
 * - `in_progress`: a run is going; nothing to read yet, so poll.
 * - `failed`: the run failed before producing a report. Nothing to fix from analysis.
 * - `complete`: a report landed. `issues` is the branch's CURRENTLY open set (read live, so it can be more current
 *   than the PR comment, which renders once per run), and an empty list beside a `passed` verdict is a clean PR.
 */
export const analysisForPrSchema = z.discriminatedUnion("status", [
    z.object({ status: z.literal("no_analysis") }),
    z.object({ status: z.literal("in_progress") }),
    z.object({ status: z.literal("failed"), failureReason: z.string().optional() }),
    z.object({
        status: z.literal("complete"),
        /** The app-health verdict: `client_bug` when the branch has an open bug issue, else `passed`. */
        verdict: analysisVerdictSchema,
        /** The Reporter's one-paragraph summary of the run. */
        summary: z.string().optional(),
        /** The Reporter's holistic report prose. Its `evidence:` image tokens resolve against `reportEvidence`, and
         * its `issue:` tokens against the `issues` below. */
        reportMarkdown: z.string().optional(),
        reportEvidence: z.array(resolvedEvidenceAssetSchema),
        /** Per-category counts of the run's non-app-health findings. These never block the PR, and a category here
         * without a matching issue below is one the run could not turn into something actionable. */
        coverage: coverageSummarySchema.optional(),
        testCount: z.number().int().nonnegative(),
        clientBugCount: z.number().int().nonnegative(),
        /** Impact Analysis's account of why the run selected the tests it did. */
        impactReasoning: z.string().optional(),
        /** The PR overview page (login required). */
        prUrl: z.string(),
        /** The branch's open issues, every kind, most actionable first. */
        issues: z.array(analysisPrIssueSchema),
        newerRun: analysisPrNewerRunSchema.optional(),
    }),
]);
export type AnalysisForPr = z.infer<typeof analysisForPrSchema>;

/**
 * One unresolved problem on an application's main branch. `occurrences` counts the distinct runs that attributed
 * a finding to the issue; `lastSeenAt` is the newest of those findings.
 */
export const mainOpenProblemSchema = z.object({
    id: z.string(),
    title: z.string(),
    kind: analysisIssueKindSchema,
    severity: analysisIssueSeveritySchema,
    /** The issue's own account of what went wrong. */
    detail: z.string().optional(),
    occurrences: z.number().int().nonnegative(),
    lastSeenAt: z.date(),
});
export type MainOpenProblem = z.infer<typeof mainOpenProblemSchema>;

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
