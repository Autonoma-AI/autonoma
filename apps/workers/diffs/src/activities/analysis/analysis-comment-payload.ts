import type { AppHealthVerdict } from "@autonoma/diffs/analysis";
import type {
    AutonomaCommentBug,
    AutonomaCommentCta,
    AutonomaCommentEvidence,
    AutonomaCommentPayload,
    AutonomaCommentState,
} from "@autonoma/github/comment";
import { ANALYSIS_VERDICT, type AnalysisVerdict, type CoverageSummary } from "@autonoma/types";

/** The only finding category the comment renders as a card - every coverage finding is summarized in a line. */
const CLIENT_BUG = ANALYSIS_VERDICT.client_bug;

/**
 * A human noun for each verdict, keyed over the SSOT enum so a new verdict is a compile error until it is given
 * copy. Only the coverage-plane categories ever surface in the coverage line; the app-health entries exist to keep
 * the record exhaustive.
 */
const COVERAGE_CATEGORY_NOUN: Record<AnalysisVerdict, string> = {
    client_bug: "client bug",
    passed: "passing test",
    engine_artifact: "engine artifact",
    environment_failure: "environment failure",
    scenario_issue: "scenario issue",
    delete: "removed test",
};

/** URLs + PR identifiers the comment links to. */
export interface AnalysisCommentContext {
    prNumber: number;
    commitSha: string;
    /** The in-app PR overview page URL; the top-level "Open in Autonoma" CTA lands here. */
    prUrl: string;
    /** The in-app analysis report base URL for this snapshot; each client-bug card appends its `findingKey`. */
    reportBaseUrl: string;
    /** The branch's preview environment URL, if deployed. */
    previewUrl?: string;
    /** Base URL the comment's status/CTA image assets are served from. */
    assetBaseUrl: string;
}

/** One `client_bug` finding rendered as a rich card. Media stay as `s3://` keys until signed on render. */
export interface AnalysisClientBugFinding {
    /** The stable per-report routing id the finding-detail page is keyed on. */
    findingKey: string;
    headline: string;
    whatHappened?: string;
    remediation?: string;
    evidence: AutonomaCommentEvidence[];
    /** `s3://` GIF clip of the failure, preferred over the static screenshot; signed on render. */
    clipKey?: string;
    /** `s3://` final-screenshot key; the fallback media when there is no clip. */
    screenshotKey?: string;
}

/** The finalized run the comment summarizes - read from the persisted `AnalysisReport` + `AnalysisFinding`. */
export interface AnalysisCommentInput {
    /** The app-health verdict driving the headline: `client_bug` or `passed`. */
    verdict: AppHealthVerdict;
    /** The client bugs, each a rich card. The only findings shown as cards; coverage findings ride the line. */
    clientBugs: AnalysisClientBugFinding[];
    /** The coverage-confidence plane summary, rendered as one caveat line. Absent when unavailable/malformed. */
    coverage?: CoverageSummary;
    /** The constrained narration prose, rendered under the headline. Absent when the model could not run. */
    narration?: string;
}

/**
 * Build the shared GitHub-comment payload for an authoritative analysis run, from its persisted two-plane
 * verdict. The two-plane model drives the shape: only `client_bug` counts against the PR, so it alone sets the
 * headline state (`critical` vs `healthy`) and is the only finding rendered as a card. The coverage-confidence
 * plane never blocks - it is condensed into a single caveat line (proposed tests that could not be established,
 * obsolete tests removed, engine/environment/scenario counts) - and the constrained narration rides under the
 * headline. Reuses the shared `AutonomaCommentPayload` + `renderMarkdown`; screenshots are signed via the
 * injected signer.
 */
export async function buildAnalysisCommentPayload(
    input: AnalysisCommentInput,
    context: AnalysisCommentContext,
    signScreenshot: (s3Key: string) => Promise<string | undefined>,
): Promise<AutonomaCommentPayload> {
    // Only client bugs count against the PR; the coverage plane never degrades the headline (two-plane invariant).
    const state: AutonomaCommentState = input.verdict === CLIENT_BUG ? "critical" : "healthy";
    const bugs = await Promise.all(input.clientBugs.map((finding) => toBug(finding, context, signScreenshot)));

    const ctas: AutonomaCommentCta[] = [{ label: "Open in Autonoma", href: context.prUrl }];
    if (context.previewUrl != null && context.previewUrl !== "") {
        ctas.push({ label: "See preview", href: context.previewUrl });
    }

    const coverageLine = buildCoverageLine(input.coverage);
    return {
        state,
        prNumber: context.prNumber,
        headline: buildHeadline(input.verdict, input.clientBugs.length),
        summary: input.narration,
        commitRef: context.commitSha.slice(0, 7),
        assetBaseUrl: context.assetBaseUrl,
        ctas,
        services: [],
        addons: [],
        warnings: coverageLine != null ? [coverageLine] : [],
        details: [],
        bugs,
    };
}

/** App-health headline: the bug count when the app misbehaved, else a clean pass. */
function buildHeadline(verdict: AppHealthVerdict, clientBugCount: number): string {
    if (verdict === CLIENT_BUG) {
        return `Autonoma found ${clientBugCount} ${clientBugCount === 1 ? "bug" : "bugs"} in this PR.`;
    }
    return "Autonoma found no issues in this PR.";
}

/**
 * One line summarizing the coverage-confidence plane: the delete split (proposed tests that could not be
 * established, pre-existing tests removed as obsolete) plus the per-category counts. `delete` is skipped in the
 * per-category loop because it is already represented by the split. Returns undefined when the plane is empty, so
 * a clean run shows no caveat line.
 */
function buildCoverageLine(coverage: CoverageSummary | undefined): string | undefined {
    if (coverage == null) return undefined;
    const parts: string[] = [];
    if (coverage.unestablishedProposed > 0) {
        parts.push(`${countNoun(coverage.unestablishedProposed, "proposed test")} could not be established`);
    }
    if (coverage.obsoleteRemoved > 0) {
        parts.push(`${countNoun(coverage.obsoleteRemoved, "obsolete test")} removed`);
    }
    for (const entry of coverage.byCategory) {
        if (entry.category === "delete") continue;
        if (entry.count <= 0) continue;
        parts.push(countNoun(entry.count, COVERAGE_CATEGORY_NOUN[entry.category]));
    }
    if (parts.length === 0) return undefined;
    return parts.join(" · ");
}

function countNoun(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function toBug(
    finding: AnalysisClientBugFinding,
    context: AnalysisCommentContext,
    signScreenshot: (s3Key: string) => Promise<string | undefined>,
): Promise<AutonomaCommentBug> {
    const findingUrl = `${context.reportBaseUrl}/${encodeURIComponent(finding.findingKey)}`;
    // Prefer the animated GIF clip of the failure over the static final screenshot; GitHub renders both inline.
    const mediaKey = finding.clipKey ?? finding.screenshotKey;
    // "Watch replay" is only worth surfacing when there is a recording clip; otherwise the media links to the report.
    const replayHref = finding.clipKey != null ? findingUrl : undefined;
    return signMedia(mediaKey, signScreenshot).then((screenshotUrl) => ({
        title: finding.headline,
        href: findingUrl,
        markerState: "critical",
        replayHref,
        screenshotUrl,
        description: finding.whatHappened,
        remediation: finding.remediation,
        evidence: finding.evidence,
        previewHref: context.previewUrl,
    }));
}

async function signMedia(
    s3Key: string | undefined,
    signScreenshot: (s3Key: string) => Promise<string | undefined>,
): Promise<string | undefined> {
    if (s3Key == null) return undefined;
    return signScreenshot(s3Key);
}
