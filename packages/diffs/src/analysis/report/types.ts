import type {
    AnalysisVerdict,
    EvidenceManifestEntry,
    InvestigationEvidence,
    OverlayPoint,
    PrimaryScreenshot,
    SuspectedCause,
} from "@autonoma/types";
import { z } from "zod";
import type { ScreenshotLoader } from "../../agents/tools/screenshot/screenshot-types";
import type { Codebase } from "../../codebase";

/**
 * The Reporter's own DTOs, kept analysis-native so nothing here depends on the deprecated healing/bugs path.
 * The agent consumes a job's findings plus the branch's evolving issues and prior reports, and authors de-duped,
 * branch-scoped Issues plus a holistic PR report. These types are the in-memory contract the fixtures/tests
 * exercise; the pipeline does not call the Reporter yet.
 */

/** The class of problem an issue represents. */
export const reporterIssueKindSchema = z.enum(["bug", "environment", "scenario"]);
export type ReporterIssueKind = z.infer<typeof reporterIssueKindSchema>;

/** The Reporter's severity call for an issue. */
export const reporterIssueSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type ReporterIssueSeverity = z.infer<typeof reporterIssueSeveritySchema>;

/** An issue's lifecycle state. */
export const reporterIssueStatusSchema = z.enum(["open", "resolved"]);
export type ReporterIssueStatus = z.infer<typeof reporterIssueStatusSchema>;

/** The PR the run analyzed - a tiny header the prompt embeds directly (no tool needed). */
export interface ReporterPrMeta {
    number: number;
    title?: string;
    body?: string;
}

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
    /** Whether the Investigator rewrote this test's plan before reaching the verdict (a retry-context signal). */
    planEdited: boolean;
    /** The Investigator's note about what it self-healed, when it did (retry context - brief prose color only). */
    selfHealNote?: string;
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
 * included so a regression can reopen one. `findingSlugs` is the set of test slugs the issue currently covers -
 * the anchor for the finish-time coverage checks.
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
    pr: ReporterPrMeta;
    /** The Impact Analysis stage's account of why it selected the tests it did (provenance/context). */
    impactReasoning?: string;
    findings: ReporterFinding[];
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

/** What the Reporter returns: the holistic report prose plus every issue reconciliation. */
export interface ReporterResult {
    /** The holistic PR report prose (Markdown), grounded. */
    reportMarkdown: string;
    /** The assets `reportMarkdown` may embed inline by `evidence:<assetId>` token. */
    reportEvidenceManifest: EvidenceManifestEntry[];
    issues: ReporterIssueResult[];
}
