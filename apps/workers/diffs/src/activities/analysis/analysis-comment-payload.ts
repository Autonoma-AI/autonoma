import { MERGE_GATE_SKIP_COMMAND } from "@autonoma/github/check";
import { buildAgentHandoffLinks, capHandoffPrompt } from "@autonoma/github/comment";
import type {
    AutonomaCommentBug,
    AutonomaCommentCta,
    AutonomaCommentEvidence,
    AutonomaCommentHandoff,
    AutonomaCommentPayload,
    AutonomaCommentState,
} from "@autonoma/github/comment";
import {
    type AnalysisVerdict,
    type AnalysisVerdictState,
    type CoverageSummary,
    type SuspectedCause,
    analysisVerdictHeadline,
    analysisVerdictLabel,
    buildAnalysisFindingUrl,
    buildAnalysisIssueUrl,
    buildPreviewFrontDoorUrl,
    buildPrPageUrl,
    deriveAnalysisVerdict,
} from "@autonoma/types";

/** The comment state each PR verdict renders as: amber `warning` for a run we could not confirm, red for a bug. */
const COMMENT_STATE: Record<AnalysisVerdictState, AutonomaCommentState> = {
    bug_found: "critical",
    not_confirmed: "warning",
    no_tests_affected: "incomplete",
    healthy: "healthy",
};

/**
 * The skip-instruction callout appended under the headline when the merge gate is blocking this PR. States that a
 * reason is required (a bare `/autonoma-skip` is rejected) and that it is posted publicly on the PR.
 */
const MERGE_GATE_SKIP_CALLOUT =
    `> 🔒 This check blocks merging. Fix the reported bug(s), or comment \`${MERGE_GATE_SKIP_COMMAND} <reason>\` ` +
    "on this PR to merge anyway. A reason is required, and it is posted publicly on the PR.";

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
    plan_mismatch: "unresolved test",
    invalid_test: "invalid test",
};

/** URLs + PR identifiers the comment links to. */
export interface AnalysisCommentContext {
    prNumber: number;
    /** `owner/repo`, for the handoff prompt's PR reference and the Claude Code deep-link's repository param. */
    repoFullName: string;
    commitSha: string;
    /** The application's slug, which every in-app deep link is built from. */
    appSlug: string;
    /** The branch's raw preview environment URL, if deployed. Wrapped in the front door before it reaches a reader. */
    previewUrl?: string;
    /** Public origin the in-app links and the preview front door are built on. */
    appBaseUrl: string;
    /** Base URL the comment's status/CTA image assets are served from. */
    assetBaseUrl: string;
}

/** The per-snapshot finding page coordinates of the run an issue designated as its clearest reproduction. */
export interface AnalysisCommentReplay {
    snapshotId: string;
    /** The stable per-report routing id the finding-detail page is keyed on. */
    findingId: string;
}

/** One open bug issue rendered as a rich card. Media stays as an `s3://` key until signed on render. */
export interface AnalysisCommentIssue {
    /** The branch-scoped issue id the issue-detail page is keyed on. */
    id: string;
    title: string;
    /** The Expected side of the case. Not on the card (which leads with what broke) but in the handoff prompt. */
    expectedBehavior?: string;
    /** The Actual side of the case, shown as the card's description. */
    actualBehavior: string;
    /** `s3://` primary-screenshot key - the issue's own hero frame, and the fallback media when there is no clip. */
    screenshotKey?: string;
    /**
     * `s3://` GIF clip of the designated reproduction, preferred over the static hero: in a comment, motion shows
     * the failure happening, and the hero's one advantage (its pin) is not rendered by GitHub anyway.
     */
    clipKey?: string;
    /** Where the designated reproduction lives, for the "Watch replay" deep-link. Absent when none was resolved. */
    replay?: AnalysisCommentReplay;
    /**
     * The grounded, code-level diagnosis. Its explanation becomes the card's "Suspected cause" line and its code
     * references become the nested Evidence collapsible a coding agent reads.
     */
    suspectedCause?: SuspectedCause;
}

/** The finalized run the comment summarizes - read from the persisted `AnalysisReport` + open bug `AnalysisIssue`s. */
export interface AnalysisCommentInput {
    /** Tests that produced a terminal verdict this run; zero means nothing was exercised (no tests affected). */
    testCount: number;
    /** The branch's open bug issues, each a rich card deep-linking to its issue-detail page. */
    bugIssues: AnalysisCommentIssue[];
    /** The coverage-confidence plane summary, rendered as one caveat line. Absent when unavailable/malformed. */
    coverage?: CoverageSummary;
    /** True when the merge gate is live for this org and the verdict blocks the PR; drives the skip-instruction callout. */
    mergeGateBlocking?: boolean;
    /** The Reporter's one-paragraph run summary, rendered under the headline. Absent on a pre-Reporter run. */
    summary?: string;
}

/**
 * Build the shared GitHub-comment payload for an authoritative analysis run, issues-first. Only bug issues count
 * against the PR, so they alone set the headline state (`critical` vs `healthy`) and are the only cards - each
 * deep-linking to its branch-scoped issue-detail page (stable across snapshots), fixing the old finding-key path.
 * The coverage-confidence plane never blocks - it is condensed into a single caveat line - and the Reporter's
 * one-paragraph summary rides under the headline. Reuses the shared `AutonomaCommentPayload` + `renderMarkdown`;
 * media is signed via the injected signer.
 */
export async function buildAnalysisCommentPayload(
    input: AnalysisCommentInput,
    context: AnalysisCommentContext,
    signScreenshot: (s3Key: string) => Promise<string | undefined>,
): Promise<AutonomaCommentPayload> {
    // The verdict every surface shares, computed from counts alone - never from the Reporter's prose, which cannot be
    // allowed to talk an unconfirmed run into reading green.
    const verdictCounts = {
        bugCount: input.bugIssues.length,
        coverageGapCount: input.coverage?.total ?? 0,
        investigatedCount: input.testCount,
    };
    const verdictState = deriveAnalysisVerdict(verdictCounts);
    const state: AutonomaCommentState = COMMENT_STATE[verdictState];

    // The visible preview links (the top CTA and each bug's "Open preview") point at
    // the front door, which forks a browser to the waiting page from an agent to the
    // raw URL. The raw URL rides along in the hidden machine-readable block - this
    // comment carries no services list, so without it an agent reading the body would
    // have no direct preview URL at all.
    const hasPreview = context.previewUrl != null && context.previewUrl !== "";
    const previewFrontDoorUrl = hasPreview
        ? buildPreviewFrontDoorUrl(context.appBaseUrl, context.previewUrl!)
        : undefined;

    const bugs = await Promise.all(
        input.bugIssues.map((issue) => toBug(issue, context, previewFrontDoorUrl, signScreenshot)),
    );

    const ctas: AutonomaCommentCta[] = [{ label: "Open in Autonoma", href: buildPrUrl(context) }];
    if (previewFrontDoorUrl != null) {
        ctas.push({ label: "See preview", href: previewFrontDoorUrl });
    }

    const coverageLine = buildCoverageLine(input.coverage);
    return {
        state,
        stateLabel: analysisVerdictLabel(verdictState),
        prNumber: context.prNumber,
        headline: analysisVerdictHeadline(verdictCounts),
        summary: buildSummary(input.summary, input.mergeGateBlocking),
        handoff: input.bugIssues.length > 0 ? buildHandoff(input.bugIssues, context) : undefined,
        commitRef: context.commitSha.slice(0, 7),
        assetBaseUrl: context.assetBaseUrl,
        ctas,
        services: [],
        addons: [],
        warnings: coverageLine != null ? [coverageLine] : [],
        details: [],
        previewUrls: hasPreview ? [context.previewUrl!] : [],
        bugs,
    };
}

/**
 * The prose block rendered under the headline: the Reporter's one-paragraph summary, plus the skip-instruction
 * callout when the merge gate is blocking this PR. Either may be absent; returns undefined when both are.
 */
function buildSummary(summary: string | undefined, mergeGateBlocking: boolean | undefined): string | undefined {
    const parts: string[] = [];
    if (summary != null && summary !== "") parts.push(summary);
    if (mergeGateBlocking === true) parts.push(MERGE_GATE_SKIP_CALLOUT);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * One line summarizing the coverage-confidence plane: the per-category counts (engine artifacts, environment /
 * scenario failures, and the unresolved `plan_mismatch` tests the run kept). Returns undefined when the plane is
 * empty, so a clean run shows no caveat line.
 */
function buildCoverageLine(coverage: CoverageSummary | undefined): string | undefined {
    if (coverage == null) return undefined;
    const parts: string[] = [];
    for (const entry of coverage.byCategory) {
        if (entry.count <= 0) continue;
        parts.push(countNoun(entry.count, COVERAGE_CATEGORY_NOUN[entry.category]));
    }
    if (parts.length === 0) return undefined;
    return parts.join(" · ");
}

function countNoun(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One open bug issue as a rich card. The card's two links mean different things: the title and "See full report" go
 * to the branch-scoped ISSUE (the cross-snapshot case), while the media and "Watch replay" go to the specific RUN
 * the Reporter designated as the clearest reproduction. The animated clip is preferred over the issue's hero frame -
 * motion shows the failure happening, and GitHub does not render the hero's pin, which is its only edge here.
 */
function toBug(
    issue: AnalysisCommentIssue,
    context: AnalysisCommentContext,
    previewHref: string | undefined,
    signScreenshot: (s3Key: string) => Promise<string | undefined>,
): Promise<AutonomaCommentBug> {
    const issueUrl = buildIssueUrl(issue, context);
    const mediaKey = issue.clipKey ?? issue.screenshotKey;
    // "Watch replay" is only worth a button when there is motion to watch; a static hero just links to the issue.
    const replayHref = issue.clipKey != null ? buildReplayUrl(issue, context) : undefined;
    return signMedia(mediaKey, signScreenshot).then((screenshotUrl) => ({
        title: issue.title,
        href: issueUrl,
        markerState: "critical",
        screenshotUrl,
        replayHref,
        description: issue.actualBehavior,
        suspectedCause: issue.suspectedCause?.explanation,
        evidence: toEvidence(issue.suspectedCause),
        previewHref,
    }));
}

/** The in-app PR overview URL - the "Open in Autonoma" CTA, and the handoff prompt's full-report link. */
function buildPrUrl(context: AnalysisCommentContext): string {
    return buildPrPageUrl(context.appBaseUrl, context.appSlug, context.prNumber);
}

/** The branch-scoped issue-detail URL - the card's title link and the handoff prompt's "Issue details". */
function buildIssueUrl(issue: AnalysisCommentIssue, context: AnalysisCommentContext): string {
    return buildAnalysisIssueUrl(context.appBaseUrl, context.appSlug, context.prNumber, issue.id);
}

/** The designated reproduction's finding-detail URL, when the issue resolved one. */
function buildReplayUrl(issue: AnalysisCommentIssue, context: AnalysisCommentContext): string | undefined {
    if (issue.replay == null) return undefined;
    const { snapshotId, findingId } = issue.replay;
    return buildAnalysisFindingUrl(context.appBaseUrl, context.appSlug, context.prNumber, snapshotId, findingId);
}

/**
 * The "hand off to a coding agent" block: a paste-ready brief in a copy-buttoned code fence plus prefilled
 * "open in <agent>" deep-links. This is where fix guidance belongs - the cards diagnose (expected/actual +
 * suspected cause), and the reader's own agent decides what to change, with the grounded evidence in hand.
 *
 * Built from the branch's open BUG issues, matching the cards, so the prompt and the comment always agree.
 */
function buildHandoff(issues: AnalysisCommentIssue[], context: AnalysisCommentContext): AutonomaCommentHandoff {
    const prompt = capHandoffPrompt(buildHandoffPrompt(issues, context), buildPrUrl(context));
    return { prompt, links: buildAgentHandoffLinks(prompt, context.repoFullName) };
}

function buildHandoffPrompt(issues: AnalysisCommentIssue[], context: AnalysisCommentContext): string {
    const header = [
        `Fix the following bug(s) Autonoma found in pull request ${context.repoFullName}#${context.prNumber} (commit ${context.commitSha.slice(0, 7)}).`,
        "Each issue gives what the app should have done, what it actually did, a hedged suspected cause with the file:line evidence behind it, and a link to the run that reproduces it. The suspected cause is a lead, not a verdict - confirm it against the code before changing anything. Apply the fixes, then re-run the affected flows to confirm.",
        // The in-app links below need an Autonoma login; the MCP is the auth-free channel for an agent.
        `Live issues via MCP: connect the Autonoma MCP (\`claude mcp add --transport http autonoma https://api.autonoma.app/v1/mcp/debug\`, or your client's MCP config) and call \`get_analysis(repoFullName="${context.repoFullName}", prNumber=${context.prNumber})\` for these issues + evidence live; it also exposes this PR's deploy status and build/app logs.`,
    ].join("\n\n");
    const rendered = issues.map((issue, index) => renderIssueForPrompt(issue, index + 1, context));
    return [header, ...rendered, `Full report (login required): ${buildPrUrl(context)}`].join("\n\n");
}

function renderIssueForPrompt(issue: AnalysisCommentIssue, index: number, context: AnalysisCommentContext): string {
    const parts = [`## ${index}. ${issue.title}`];
    if (issue.expectedBehavior != null && issue.expectedBehavior !== "") {
        parts.push(`Expected: ${issue.expectedBehavior}`);
    }
    parts.push(`Actual: ${issue.actualBehavior}`);
    if (issue.suspectedCause != null) {
        parts.push(`Suspected cause: ${issue.suspectedCause.explanation}`);
        const refs = issue.suspectedCause.codeReferences.map(renderCodeReferenceForPrompt);
        if (refs.length > 0) parts.push(`Evidence:\n${refs.join("\n")}`);
    }
    parts.push(`Issue details: ${buildIssueUrl(issue, context)}`);
    const replayUrl = buildReplayUrl(issue, context);
    if (replayUrl != null) parts.push(`Run that reproduces it: ${replayUrl}`);
    return parts.join("\n");
}

function renderCodeReferenceForPrompt(ref: SuspectedCause["codeReferences"][number]): string {
    const location = `${ref.file}${ref.lines != null ? `:${ref.lines}` : ""}`;
    const head = `- ${location}`;
    if (ref.snippet == null || ref.snippet === "") return head;
    return `${head}\n\`\`\`\n${ref.snippet}\n\`\`\``;
}

/**
 * The nested Evidence collapsible, from the suspected cause's grounded code references. Every reference was
 * validated against the checked-out repo when the issue was authored, so a coding agent reading this block gets
 * file:line locations that really exist. `source` labels the block for the renderer's syntax highlighting, which
 * otherwise falls back to the file extension.
 */
function toEvidence(cause: SuspectedCause | undefined): AutonomaCommentEvidence[] {
    if (cause == null) return [];
    return cause.codeReferences.map((ref) => ({
        source: "code",
        file: ref.file,
        lines: ref.lines,
        snippet: ref.snippet,
    }));
}

async function signMedia(
    s3Key: string | undefined,
    signScreenshot: (s3Key: string) => Promise<string | undefined>,
): Promise<string | undefined> {
    if (s3Key == null) return undefined;
    return signScreenshot(s3Key);
}
