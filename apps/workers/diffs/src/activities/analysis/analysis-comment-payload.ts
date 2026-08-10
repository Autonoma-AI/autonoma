import { MERGE_GATE_SKIP_COMMAND } from "@autonoma/github/check";
import { buildAgentHandoffLinks, capHandoffPrompt } from "@autonoma/github/comment";
import type {
    AutonomaCommentBug,
    AutonomaCommentCta,
    AutonomaCommentEvidence,
    AutonomaCommentFlow,
    AutonomaCommentFlowGroup,
    AutonomaCommentHandoff,
    AutonomaCommentNote,
    AutonomaCommentPayload,
    AutonomaCommentState,
} from "@autonoma/github/comment";
import {
    ANALYSIS_VERDICT,
    type AnalysisVerdict,
    type AnalysisVerdictCounts,
    type AnalysisVerdictState,
    type CoverageSummary,
    type SuspectedCause,
    type AnalysisFlow,
    analysisFlowComposition,
    analysisPrTitle,
    analysisVerdictHeadline,
    buildAnalysisFindingUrl,
    buildAnalysisIssueUrl,
    buildPreviewFrontDoorUrl,
    buildPrPageUrl,
    derivePrVerdict,
} from "@autonoma/types";

/**
 * The comment state each PR verdict renders as: amber `warning` for a run we could not confirm, red for a bug.
 *
 * `no_tests_needed` is green, alongside a verified run. GitHub renders these as a tick, a grey circle or a red cross -
 * there is no calm grey - so any non-green marker reads as an unresolved problem, and a change we deliberately
 * decided needed no test is not one. The distinction between the two green outcomes is carried by the state label
 * and the headline, which say which of the two happened.
 */
const COMMENT_STATE: Record<AnalysisVerdictState, AutonomaCommentState> = {
    bug_found: "critical",
    not_confirmed: "warning",
    no_tests_needed: "healthy",
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
 * copy. Only the coverage-plane categories ever surface in the body blocks; the app-health entries exist to keep
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

/** The wins block. Listed in the comment, not buried behind a click: most readers never open the PR page. */
const VERIFIED_HEADING = "✅ What we verified";

/** The one block the reader can act on. */
const YOURS_HEADING = "⚠️ Couldn't check - yours to fix";
const YOURS_WHY =
    "These are setup gaps, not app bugs - but they block every future run on this branch until they are fixed, not just this one.";
const YOURS_ISSUES_LEAD = "What to fix:";

/** Reported so the reader knows what was skipped, never asked of them. */
const OURS_HEADING = "Couldn't check - on us";
const OURS_WHY = "Nothing here is yours to fix.";

/** How many flows one group shows before linking the rest; a long branch must not bury the comment. */
const MAX_FLOWS_PER_GROUP = 6;

/**
 * The one note the comment still carries. A removed test is a conclusion rather than a problem, so it is stated once,
 * quietly, and asked of nobody - which is also why it is not a flow.
 */
function buildCoverageNotes(input: AnalysisCommentInput): AutonomaCommentNote[] {
    const removed = countFor(input.coverage, ANALYSIS_VERDICT.invalid_test);
    if (removed === 0) return [];
    return [{ tone: "quiet", items: [], lines: [describeRemovedTests(removed)], links: [] }];
}

/** The removal line, whose grammar is the only reason the two readings are separate copy. */
const REMOVED_TEST_WHY = "it covered something the app contradicts, so it will not run again";
const REMOVED_TESTS_WHY = "they covered something the app contradicts, so they will not run again";

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

/** One issue behind a client-owned coverage gap: the Reporter's own words for what has to be fixed. */
export interface AnalysisCommentCoverageIssue {
    /** The branch-scoped issue id the issue-detail page is keyed on. */
    id: string;
    title: string;
}

/** The finalized run the comment summarizes - read from the persisted `AnalysisReport` + open bug `AnalysisIssue`s. */
export interface AnalysisCommentInput {
    /** Tests that produced a terminal verdict this run; zero means nothing was exercised. */
    testCount: number;
    /** The branch's open bug issues, each a rich card deep-linking to its issue-detail page. */
    bugIssues: AnalysisCommentIssue[];
    /** The coverage-confidence plane summary, partitioned by owner into the body blocks. Absent when malformed. */
    coverage?: CoverageSummary;
    /** The open issues behind this run's client-owned gaps - what to fix, in the Reporter's words. */
    coverageIssues?: AnalysisCommentCoverageIssue[];
    /** True when the merge gate is live for this org and the verdict blocks the PR; drives the skip-instruction callout. */
    mergeGateBlocking?: boolean;
    /** The Reporter's title. Empty on a report written before the Reporter authored one. */
    title?: string;
    /** The Reporter's headline for the PR as a whole. */
    headline?: string;
    /** The branch's flow itemization - what this PR has established and what it has not. Absent on a pre-flows run. */
    flows?: AnalysisFlow[];
    /** The PR page, where a capped group's remaining flows are shown in full. */
    prPageUrl?: string;
}

/**
 * Build the shared GitHub-comment payload for an authoritative analysis run, issues-first. Only bug issues count
 * against the PR, so they alone are the cards - each deep-linking to its branch-scoped issue-detail page, which is
 * stable across snapshots. The Reporter's one-paragraph summary rides under the headline.
 *
 * The top-line state and headline are the deterministic PR verdict, computed from counts alone; FAULT never touches
 * them. Fault shapes the BODY instead: the coverage-confidence plane is partitioned by owner into a visible "needs
 * your attention" block for what only the reader can fix and a quiet "on our side" block for what is ours - so a run
 * we could not confirm says which gaps are actionable without nagging about the ones that are not. Reuses the shared
 * `AutonomaCommentPayload` + `renderMarkdown`; media is signed via the injected signer.
 */
export async function buildAnalysisCommentPayload(
    input: AnalysisCommentInput,
    context: AnalysisCommentContext,
    signScreenshot: (s3Key: string) => Promise<string | undefined>,
): Promise<AutonomaCommentPayload> {
    // The verdict every surface shares, derived from the flow itemization when the run has one and from its raw
    // counts when it does not - never from the Reporter's prose, which cannot be allowed to talk an unconfirmed run
    // into reading green.
    const flows = input.flows ?? [];
    const verdictCounts: AnalysisVerdictCounts = {
        bugCount: input.bugIssues.length,
        coverageGapCount: input.coverage?.total ?? 0,
        investigatedCount: input.testCount,
    };
    const verdictState = derivePrVerdict({
        flows,
        openBugCount: verdictCounts.bugCount,
        investigatedCount: verdictCounts.investigatedCount,
        coverageGapCount: verdictCounts.coverageGapCount,
    });
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

    return {
        state,
        kind: "analysis",
        prNumber: context.prNumber,
        title: analysisPrTitle(input.title ?? "", verdictState, input.bugIssues.length),
        headline: input.headline ?? analysisVerdictHeadline(verdictCounts),
        summary: input.mergeGateBlocking === true ? MERGE_GATE_SKIP_CALLOUT : undefined,
        flowGroups: buildFlowGroups(input, context, flows),
        handoff: input.bugIssues.length > 0 ? buildHandoff(input.bugIssues, context) : undefined,
        commitRef: context.commitSha.slice(0, 7),
        assetBaseUrl: context.assetBaseUrl,
        ctas,
        services: [],
        notes: buildCoverageNotes(input),
        warnings: [],
        details: [],
        previewUrls: hasPreview ? [context.previewUrl!] : [],
        bugs,
    };
}

/**
 * The flow itemization: what this pull request has established, and what it has not.
 *
 * This replaces the per-category gap counts the body used to carry ("2 engine artifacts - our runner could not
 * complete these checks"). Those named no flow and reported only losses - there was nowhere for "we confirmed guest
 * checkout" to appear at all, so a run that verified six flows of seven read as pure failure.
 *
 * A `broken` flow is deliberately absent: its bug already has a card above, and repeating it here would report the
 * same problem twice. Every other flow appears exactly once, in the group matching how much of it we established -
 * and a flow the reader can unblock is listed as theirs, since that is the only group they can act on.
 */
function buildFlowGroups(
    input: AnalysisCommentInput,
    context: AnalysisCommentContext,
    flows: readonly AnalysisFlow[],
): AutonomaCommentFlowGroup[] {
    const verified: AnalysisFlow[] = [];
    const yours: AnalysisFlow[] = [];
    const ours: AnalysisFlow[] = [];
    for (const flow of flows) {
        if (flow.status === "broken") continue;
        if (flow.status === "verified") verified.push(flow);
        else if (flow.owner === "client") yours.push(flow);
        else ours.push(flow);
    }

    const prPageUrl = input.prPageUrl ?? buildPrUrl(context);
    // The reader's issues ride on this group whenever the Reporter filed any, even when no flow landed in it: a flow
    // that mixes a bug with a client-owned gap is skipped as `broken` (its bug is already a card above), and dropping
    // the links with it would take the only actionable half out of the comment.
    const links = (input.coverageIssues ?? []).map((issue) => ({
        label: issue.title,
        href: buildAnalysisIssueUrl(context.appBaseUrl, context.appSlug, context.prNumber, issue.id),
    }));

    const groups: AutonomaCommentFlowGroup[] = [];
    if (verified.length > 0) {
        groups.push(toFlowGroup(VERIFIED_HEADING, "attention", verified, [], prPageUrl));
    }
    if (yours.length > 0 || links.length > 0) {
        const lines = links.length > 0 ? [YOURS_WHY, YOURS_ISSUES_LEAD] : [YOURS_WHY];
        groups.push(toFlowGroup(YOURS_HEADING, "attention", yours, lines, prPageUrl, links));
    }
    if (ours.length > 0) {
        groups.push(toFlowGroup(OURS_HEADING, "quiet", ours, [OURS_WHY], prPageUrl));
    }
    return groups;
}

/** One group, capped so a large branch does not bury the comment; the rest are a click away on the PR page. */
function toFlowGroup(
    heading: string,
    tone: "attention" | "quiet",
    flows: AnalysisFlow[],
    lines: string[],
    prPageUrl: string,
    links: AutonomaCommentCta[] = [],
): AutonomaCommentFlowGroup {
    const shown = flows.slice(0, MAX_FLOWS_PER_GROUP);
    const hidden = flows.length - shown.length;
    return {
        heading,
        tone,
        flows: shown.map(toCommentFlow),
        lines,
        links,
        overflow: hidden > 0 ? { count: hidden, href: prPageUrl } : undefined,
    };
}

/**
 * One flow as the comment shows it. The composition line - where a mixed flow stays honest, since three passing
 * checks beside one that could not run is not a flat failure - is shared with the PR page, so the two surfaces cannot
 * word the same flow differently.
 */
function toCommentFlow(flow: AnalysisFlow): AutonomaCommentFlow {
    return { title: flow.title, detail: flow.detail, meta: analysisFlowComposition(flow) };
}

/** The removed-test line: a deliberate, evidence-backed removal, stated once and left alone. */
function describeRemovedTests(count: number): string {
    const noun = describeCount(ANALYSIS_VERDICT.invalid_test, count);
    return `${noun} removed - ${count === 1 ? REMOVED_TEST_WHY : REMOVED_TESTS_WHY}.`;
}

function describeCount(category: AnalysisVerdict, count: number): string {
    const noun = COVERAGE_CATEGORY_NOUN[category];
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** How many gaps the run has in one coverage category. */
function countFor(coverage: CoverageSummary | undefined, category: AnalysisVerdict): number {
    return coverage?.byCategory.find((entry) => entry.category === category)?.count ?? 0;
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
        // The in-app links below need an Autonoma login; the MCP is the channel an agent can read
        // these issues through. `--scope user` matters: the default (`local`) binds the server to
        // whatever directory the command ran in, and the tools then appear to be missing.
        `Live issues via MCP: connect the Autonoma MCP, then call \`get_analysis(repoFullName="${context.repoFullName}", prNumber=${context.prNumber})\` for these issues + evidence live; it also exposes this PR's deploy status and build/app logs. If it is not connected, do not install it yourself: ask the user to run \`claude mcp add --transport http --scope user autonoma https://api.autonoma.app/v1/mcp\` then \`claude mcp login autonoma\` in their own terminal (or use their client's MCP config), and tell them to restart you afterwards - a running session does not pick up a server added or signed in underneath it. Without a browser, send an Autonoma API key as \`Authorization: Bearer <key>\` instead.`,
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
