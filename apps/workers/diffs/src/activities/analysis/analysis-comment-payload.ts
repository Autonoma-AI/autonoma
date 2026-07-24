import type { AppHealthVerdict } from "@autonoma/diffs/analysis";
import { buildAgentHandoffLinks, capHandoffPrompt } from "@autonoma/github/comment";
import type {
    AutonomaCommentBug,
    AutonomaCommentCta,
    AutonomaCommentEvidence,
    AutonomaCommentHandoff,
    AutonomaCommentPayload,
    AutonomaCommentState,
} from "@autonoma/github/comment";
import { ANALYSIS_VERDICT, type AnalysisVerdict, type CoverageSummary, type SuspectedCause } from "@autonoma/types";

/** The verdict that makes the comment critical - a client bug is the only class that counts against the PR. */
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
    /** `owner/repo`, for the handoff prompt's PR reference and the Claude Code deep-link's repository param. */
    repoFullName: string;
    commitSha: string;
    /** The in-app PR overview page URL; the top-level "Open in Autonoma" CTA lands here. */
    prUrl: string;
    /** The in-app issue-detail base URL for this PR; each bug card appends its `issueId`. */
    issueBaseUrl: string;
    /** The in-app snapshots base URL for this PR; a card's replay link appends `<snapshotId>/findings/<findingKey>`. */
    findingBaseUrl: string;
    /** The branch's preview environment URL, if deployed. */
    previewUrl?: string;
    /** Base URL the comment's status/CTA image assets are served from. */
    assetBaseUrl: string;
}

/** The per-snapshot finding page coordinates of the run an issue designated as its clearest reproduction. */
export interface AnalysisCommentReplay {
    snapshotId: string;
    /** The stable per-report routing id the finding-detail page is keyed on. */
    findingKey: string;
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
    /** The app-health verdict driving the headline: `client_bug` or `passed`. */
    verdict: AppHealthVerdict;
    /** The branch's open bug issues, each a rich card deep-linking to its issue-detail page. */
    bugIssues: AnalysisCommentIssue[];
    /** The coverage-confidence plane summary, rendered as one caveat line. Absent when unavailable/malformed. */
    coverage?: CoverageSummary;
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
    // Only bug issues count against the PR; the coverage plane never degrades the headline (two-plane invariant).
    const state: AutonomaCommentState = input.verdict === CLIENT_BUG ? "critical" : "healthy";
    const bugs = await Promise.all(input.bugIssues.map((issue) => toBug(issue, context, signScreenshot)));

    const ctas: AutonomaCommentCta[] = [{ label: "Open in Autonoma", href: context.prUrl }];
    if (context.previewUrl != null && context.previewUrl !== "") {
        ctas.push({ label: "See preview", href: context.previewUrl });
    }

    const coverageLine = buildCoverageLine(input.coverage);
    return {
        state,
        prNumber: context.prNumber,
        headline: buildHeadline(input.verdict, input.bugIssues.length),
        summary: input.summary,
        handoff: input.bugIssues.length > 0 ? buildHandoff(input.bugIssues, context) : undefined,
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

/** App-health headline: the open-bug count when the app misbehaved, else a clean pass. */
function buildHeadline(verdict: AppHealthVerdict, bugCount: number): string {
    if (verdict === CLIENT_BUG) {
        return `Autonoma found ${bugCount} ${bugCount === 1 ? "bug" : "bugs"} in this PR.`;
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

/**
 * One open bug issue as a rich card. The card's two links mean different things: the title and "See full report" go
 * to the branch-scoped ISSUE (the cross-snapshot case), while the media and "Watch replay" go to the specific RUN
 * the Reporter designated as the clearest reproduction. The animated clip is preferred over the issue's hero frame -
 * motion shows the failure happening, and GitHub does not render the hero's pin, which is its only edge here.
 */
function toBug(
    issue: AnalysisCommentIssue,
    context: AnalysisCommentContext,
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
        previewHref: context.previewUrl,
    }));
}

/** The branch-scoped issue-detail URL - the card's title link and the handoff prompt's "Issue details". */
function buildIssueUrl(issue: AnalysisCommentIssue, context: AnalysisCommentContext): string {
    return `${context.issueBaseUrl}/${encodeURIComponent(issue.id)}`;
}

/** The designated reproduction's finding-detail URL, when the issue resolved one. */
function buildReplayUrl(issue: AnalysisCommentIssue, context: AnalysisCommentContext): string | undefined {
    if (issue.replay == null) return undefined;
    const { snapshotId, findingKey } = issue.replay;
    return `${context.findingBaseUrl}/${encodeURIComponent(snapshotId)}/findings/${encodeURIComponent(findingKey)}`;
}

/**
 * The "hand off to a coding agent" block: a paste-ready brief in a copy-buttoned code fence plus prefilled
 * "open in <agent>" deep-links. This is where fix guidance belongs - the cards diagnose (expected/actual +
 * suspected cause), and the reader's own agent decides what to change, with the grounded evidence in hand.
 *
 * Built from the branch's open BUG issues, matching the cards, so the prompt and the comment always agree.
 */
function buildHandoff(issues: AnalysisCommentIssue[], context: AnalysisCommentContext): AutonomaCommentHandoff {
    const prompt = capHandoffPrompt(buildHandoffPrompt(issues, context), context.prUrl);
    return { prompt, links: buildAgentHandoffLinks(prompt, context.repoFullName) };
}

function buildHandoffPrompt(issues: AnalysisCommentIssue[], context: AnalysisCommentContext): string {
    const header = [
        `Fix the following bug(s) Autonoma found in pull request ${context.repoFullName}#${context.prNumber} (commit ${context.commitSha.slice(0, 7)}).`,
        "Each issue gives what the app should have done, what it actually did, a hedged suspected cause with the file:line evidence behind it, and a link to the run that reproduces it. The suspected cause is a lead, not a verdict - confirm it against the code before changing anything. Apply the fixes, then re-run the affected flows to confirm.",
        // The in-app links below need an Autonoma login; the MCP is the auth-free channel for an agent. `get_analysis`
        // is not registered on the debug MCP server yet - it must land before ANALYSIS_PR_COMMENT_ENABLED is turned
        // on for real PRs, or this line points an agent at a tool it cannot call.
        `Live issues via MCP: connect the Autonoma MCP (\`claude mcp add --transport http autonoma https://api.autonoma.app/v1/mcp/debug\`, or your client's MCP config) and call \`get_analysis(repoFullName="${context.repoFullName}", prNumber=${context.prNumber})\` for these issues + evidence live; it also exposes this PR's deploy status and build/app logs.`,
    ].join("\n\n");
    const rendered = issues.map((issue, index) => renderIssueForPrompt(issue, index + 1, context));
    return [header, ...rendered, `Full report (login required): ${context.prUrl}`].join("\n\n");
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
