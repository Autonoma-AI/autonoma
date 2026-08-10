import {
    type AnalysisFlow,
    type AnalysisIssueKind,
    analysisIssueKindSchema,
    type AnalysisIssueSeverity,
    analysisIssueSeveritySchema,
    type AnalysisIssueStatus,
    analysisIssueStatusSchema,
    type AnalysisRunTarget,
    type AnalysisVerdict,
    type EvidenceManifestEntry,
    type InvestigationEvidence,
    type OverlayPoint,
    type PrimaryScreenshot,
    type SuspectedCause,
} from "@autonoma/types";
import type { ScreenshotLoader } from "../../agents/tools/run-evidence/run-evidence-types";
import type { Codebase } from "../../codebase";
import type { FlowCorrections } from "./flows";

/**
 * The Reporter's own DTOs, kept analysis-native so nothing here depends on the deprecated healing/bugs path.
 * The agent consumes a job's findings plus the branch's evolving issues and prior reports, and authors de-duped,
 * branch-scoped Issues plus a holistic PR report. These types are the in-memory contract between the agent and the
 * reporter stage that persists its result.
 *
 * The issue kind/severity/status enums live in `@autonoma/types` (the single source of truth shared with the API
 * read path and the UI); the Reporter names are thin aliases so the write side keeps its domain vocabulary.
 */
export const reporterIssueKindSchema = analysisIssueKindSchema;
export type ReporterIssueKind = AnalysisIssueKind;

export const reporterIssueSeveritySchema = analysisIssueSeveritySchema;
export type ReporterIssueSeverity = AnalysisIssueSeverity;

export const reporterIssueStatusSchema = analysisIssueStatusSchema;
export type ReporterIssueStatus = AnalysisIssueStatus;

/**
 * One screenshot the Reporter may pull for a finding via `fetch_evidence`. The `assetId` is stable and unique
 * across the whole run; only an id offered here can be fetched, and only a fetched id can be embedded - the two
 * halves of grounding-by-construction. `s3Key` is internal and never shown to the model.
 */
export interface ReporterEvidenceAsset {
    assetId: string;
    s3Key: string;
    /** Human caption shown to the model when the screenshot is fetched (e.g. "final screen", "step 5 (after)"). */
    label: string;
    /** The resolved interaction point drawn over the frame, when the source step resolved one. */
    pin?: OverlayPoint;
}

/**
 * One test's finding as the Reporter sees it: the classifier's verdict plus the retry/self-heal context and the
 * fetchable screenshots. Passing and coverage-plane findings are included - the Reporter reasons over the whole
 * job, not just the bugs.
 */
export interface ReporterFinding {
    slug: string;
    category: AnalysisVerdict;
    headline: string;
    expectedBehavior?: string;
    actualBehavior?: string;
    /**
     * The coverage plane's account of what went wrong, in place of expected/actual (which only the app-health
     * verdicts carry). This is what an `environment_failure` is placed by: whether it traces to the reader's
     * configuration or to our own infrastructure is readable here and nowhere else.
     */
    whatHappened?: string;
    /** Whether the Investigator rewrote this test's plan and re-ran it before reaching this verdict - true when
     * the test was classified more than once (a retry-context signal, never an issue of its own). */
    selfHealed: boolean;
    plan?: string;
    observedAppIssues?: string;
    falsePositiveRisk?: string;
    /** The classifier's already-grounded code/log evidence (static context; not re-fetched). */
    codeEvidence?: InvestigationEvidence[];
    /** The screenshots the Reporter may fetch for this finding. */
    screenshots: ReporterEvidenceAsset[];
}

/**
 * An existing branch-scoped issue the Reporter must reconcile against this job. Mostly open; resolved issues are
 * included so a regression can reopen one. `findingSlugs` is the set of test slugs the issue currently covers,
 * derived from the findings attributed to it - the anchor for the finish-time coverage checks.
 */
export interface ReporterExistingIssue {
    id: string;
    title: string;
    kind: ReporterIssueKind;
    severity: ReporterIssueSeverity;
    status: ReporterIssueStatus;
    expectedBehavior?: string;
    actualBehavior: string;
    /** A short summary of the narrative (not the full prose) - enough for cross-time matching. */
    narrativeSummary?: string;
    findingSlugs: string[];
}

/** A previous snapshot's holistic report prose, given as context so the Reporter writes a cumulative narrative. */
export interface ReporterPriorReport {
    snapshotId: string;
    reportMarkdown: string;
}

/**
 * One test in the branch's LAST-KNOWN VERDICT MAP: every test any snapshot of this PR has investigated, carrying its
 * most recent verdict. This is what the report describes, rather than one snapshot's findings.
 *
 * The reasoning is that Impact Analysis's non-selection is itself a judgement. A test the latest diff did not select
 * was affirmatively decided to be unaffected by it, so its earlier pass is the best evidence available and evidence we
 * deliberately chose not to refresh. A test that WAS re-selected and then hit a fault supersedes its own earlier pass,
 * because the map only ever holds the most recent verdict.
 *
 * Structurally a superset of `AnalysisFlowMember`, so it can be handed straight to the flow derivation.
 */
export interface ReporterBranchTest {
    slug: string;
    /** The test's name - the agent clusters on meaning, and a slug is a poor carrier of it. */
    name: string;
    category: AnalysisVerdict;
    /** Whether this verdict came from the run being reported, or was carried from an earlier snapshot. */
    checkedThisRun: boolean;
    /** Whether the finding sits under a client-owned issue - the only reading of an `environment_failure`'s side. */
    attributedToClientIssue: boolean;
    /** One line of what happened, from the last-known classification. */
    headline?: string;
    /** The short SHA the verdict came from. Present on carried rows, where "when" is load-bearing. */
    fromSha?: string;
}

/** A one-line scenario entry; the full recipe is fetched on demand via `read_scenario`. */
export interface ReporterScenarioSummary {
    id: string;
    name: string;
    summary: string;
}

/** The full recipe `read_scenario` returns for a scenario id. */
export interface ReporterScenarioRecipe {
    id: string;
    name: string;
    description?: string;
    recipe: string;
}

/** Loads a scenario recipe by id on demand. Absent in contexts without scenario data; the tool degrades. */
export interface ReporterScenarioLoader {
    loadRecipe(scenarioId: string): Promise<ReporterScenarioRecipe | undefined>;
}

/** Everything the Reporter needs for one run: the findings, the branch's issue/report history, and its deps. */
export interface ReporterInput {
    appSlug: string;
    /** What the run analyzed - a PR (with its stated intent) or the application's main branch. A tiny header the
     * prompt embeds directly, no tool needed. */
    target: AnalysisRunTarget;
    /**
     * The run's commit range. The Reporter is told to read the diff to ground a bug's `suspectedCause` in an
     * exact `file:line`, so it needs the range that read is against - the clone has no ref for the base, and a
     * guessed range yields a real-looking citation for the wrong commits.
     */
    range: { baseSha: string; headSha: string };
    /** The Impact Analysis stage's account of why it selected the tests it did (provenance/context). */
    impactReasoning?: string;
    findings: ReporterFinding[];
    /**
     * The branch's last-known verdict per test, across every snapshot of this PR. Includes this run's findings (as
     * `checkedThisRun`) so the flows partition ONE list; the prompt renders the two halves at different fidelity.
     */
    branchTests: ReporterBranchTest[];
    existingIssues: ReporterExistingIssue[];
    priorReports: ReporterPriorReport[];
    scenarioIndex: ReporterScenarioSummary[];
    /** The checked-out repo, for the read-only `bash` tool. */
    codebase: Codebase;
    /** Rehydrates a screenshot's bytes for `fetch_evidence`; absent degrades that tool to text-only. */
    screenshotLoader?: ScreenshotLoader;
    /** Loads a full scenario recipe for `read_scenario`; absent degrades that tool. */
    scenarioLoader?: ReporterScenarioLoader;
}

/** The de-duped issue content the Reporter authored/re-stated for one issue (shared by open + carry-forward). */
export interface ReporterIssueContent {
    title: string;
    kind: ReporterIssueKind;
    severity: ReporterIssueSeverity;
    expectedBehavior?: string;
    actualBehavior: string;
    /** Grounded: any image whose evidence token was not fetched has already been stripped. */
    narrativeMarkdown: string;
    /** The assets the narrative may embed - exactly what the agent fetched and referenced. */
    evidenceManifest: EvidenceManifestEntry[];
    /** Validated against the checked-out repo at persist time; absent when nothing grounded. */
    suspectedCause?: SuspectedCause;
    /** Resolved from a fetched asset; absent when the reference was unfetched/unknown. */
    primaryScreenshot?: PrimaryScreenshot;
    /** This job's finding slugs the issue now covers. */
    findingSlugs: string[];
    /**
     * The one covered slug the agent designated as the clearest reproduction. Readers resolve the newest covering
     * finding for it to reach that run's clip and finding page - so which TEST to feature stays the agent's call
     * while which RUN to show stays mechanical. Guaranteed to be a member of {@link findingSlugs}.
     */
    primaryFindingSlug: string;
}

/**
 * One reconciliation the Reporter emits for an issue. `open` mints a new issue; `carry_forward` re-states an
 * existing issue's content and re-confirms it (the reopen path too); `resolve` closes an existing issue once its
 * covering test(s) re-ran and passed.
 */
export type ReporterIssueResult =
    | { kind: "open"; content: ReporterIssueContent }
    | { kind: "carry_forward"; existingIssueId: string; content: ReporterIssueContent }
    | { kind: "resolve"; existingIssueId: string; resolvingFindingSlug: string; note: string };

/** What the Reporter returns: how the PR reads, its flow itemization, the report prose, and every reconciliation. */
export interface ReporterResult {
    /**
     * The PR's title, about eight words. Overridden by deterministic copy for an open bug and for a run that needed
     * no tests, so what lands here is what a reader sees only in between - see `analysisPrTitle`.
     */
    title: string;
    /**
     * The PR's headline: 1-3 sentences of plain prose for the surfaces that render prose but neither Markdown blocks
     * nor our inline tokens (the GitHub comment and the PR page). States the CUMULATIVE state of the branch, not the
     * latest snapshot's counts. Flattened at persist.
     */
    headline: string;
    /** The branch's verdict map, clustered into reader-facing units, with every status and owner derived. */
    flows: AnalysisFlow[];
    /** What the partition had to correct to total the map. Measured, not enforced - nothing rejected these. */
    flowCorrections: FlowCorrections;
    /** The holistic PR report prose (Markdown), grounded. Never re-lists {@link flows}. */
    reportMarkdown: string;
    /** The assets `reportMarkdown` may embed inline by `evidence:<assetId>` token. */
    reportEvidenceManifest: EvidenceManifestEntry[];
    issues: ReporterIssueResult[];
}
