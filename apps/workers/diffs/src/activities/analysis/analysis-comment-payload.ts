import { MERGE_GATE_SKIP_COMMAND } from "@autonoma/github/check";
import { buildAgentHandoffLinks, capHandoffPrompt } from "@autonoma/github/comment";
import type {
    AutonomaCommentBug,
    AutonomaCommentCta,
    AutonomaCommentEvidence,
    AutonomaCommentHandoff,
    AutonomaCommentNote,
    AutonomaCommentPayload,
    AutonomaCommentState,
} from "@autonoma/github/comment";
import {
    ANALYSIS_VERDICT,
    type AnalysisVerdict,
    type AnalysisVerdictState,
    type CoverageSummary,
    type SuspectedCause,
    analysisCoverageOwner,
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

/**
 * What each coverage gap means for the reader, appended to its count. Keyed over the SSOT so a new verdict is a
 * compile error until it has copy; the app-health entries never render (they are not coverage gaps).
 * `environment_failure` reads differently depending on whose it is, so its client-side wording lives here and its
 * infra-side wording in {@link OUR_ENVIRONMENT_EXPLANATION}.
 */
const COVERAGE_CATEGORY_EXPLANATION: Record<AnalysisVerdict, string> = {
    client_bug: "the app misbehaved",
    passed: "the app held up",
    scenario_issue: "the test data these flows need was not seeded, so they never ran",
    environment_failure: "the preview could not be exercised with the configuration it has",
    engine_artifact: "our runner could not complete these checks",
    plan_mismatch:
        "the app rendered correctly, but the test's plan no longer matches it and our rewrite could not stabilize it",
    // Never rendered as a gap: a removal is reported on its own quiet line, not asked of either side.
    invalid_test: "the test's premise is impossible, so it was removed",
};

/** An `environment_failure` on our side: the preview infrastructure, not the reader's configuration. */
const OUR_ENVIRONMENT_EXPLANATION = "the preview environment was not reachable when we ran";

/** The visible block: gaps only the reader can fix, and why they matter beyond this run. */
const ATTENTION_HEADING = "⚠️ Needs your attention";
const ATTENTION_WHY =
    "These are setup gaps, not app bugs - but they block every future run on this branch until they are fixed, not just this one.";
/** Lead-in for the issues behind the gaps, each carrying the Reporter's account of what to fix. */
const ATTENTION_ISSUES_LEAD = "What to fix:";

/** The quiet block: gaps that are ours. Reported so the reader knows what was skipped, never asked of them. */
const OUR_SIDE_HEADING = "On our side";
const OUR_SIDE_WHY = "Nothing here is yours to fix.";

/**
 * The one gap in the quiet block that still deserves a human eye: a `plan_mismatch` is kept rather than removed
 * precisely because it might be a real defect the classifier misdiagnosed.
 */
const PLAN_MISMATCH_NOTE = "Worth a glance: an unresolved test can be a real defect we misdiagnosed.";

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
    /** Tests that produced a terminal verdict this run; zero means nothing was exercised (no tests affected). */
    testCount: number;
    /** The branch's open bug issues, each a rich card deep-linking to its issue-detail page. */
    bugIssues: AnalysisCommentIssue[];
    /** The coverage-confidence plane summary, partitioned by owner into the body blocks. Absent when malformed. */
    coverage?: CoverageSummary;
    /**
     * How many of this run's `environment_failure` gaps are the READER'S to fix. The taxonomy carries no owner field
     * for them (a preview we could not exercise can be either side), so this count is the Reporter's own placement:
     * an env gap it attributed to an open environment/scenario issue is one it judged fixable configuration. The
     * remainder are ours. Defaults to none, which keeps an unplaced env gap on our side rather than nagging.
     */
    clientEnvironmentFailures?: number;
    /** The open issues behind this run's client-owned gaps - what to fix, in the Reporter's words. */
    coverageIssues?: AnalysisCommentCoverageIssue[];
    /** True when the merge gate is live for this org and the verdict blocks the PR; drives the skip-instruction callout. */
    mergeGateBlocking?: boolean;
    /** The Reporter's one-paragraph run summary, rendered under the headline. Absent on a pre-Reporter run. */
    summary?: string;
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
        notes: buildCoverageNotes(input, context),
        warnings: [],
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
 * The coverage-confidence plane, partitioned by OWNER into the body's blocks: what only the reader can fix (visible,
 * with why it matters beyond this run and links to the issues that say what to fix), what is ours (quiet, and never
 * asked of them), and the removed `invalid_test`s (one quiet line - a deliberate removal is not a problem to report).
 *
 * Each block appears only when this run actually produced a gap for it, so a clean run's body stays empty.
 */
function buildCoverageNotes(input: AnalysisCommentInput, context: AnalysisCommentContext): AutonomaCommentNote[] {
    const gaps = partitionCoverageGaps(input);
    const notes: AutonomaCommentNote[] = [];

    if (gaps.client.length > 0) {
        const links = (input.coverageIssues ?? []).map((issue) => ({
            label: issue.title,
            href: buildAnalysisIssueUrl(context.appBaseUrl, context.appSlug, context.prNumber, issue.id),
        }));
        const lines = links.length > 0 ? [ATTENTION_WHY, ATTENTION_ISSUES_LEAD] : [ATTENTION_WHY];
        notes.push({
            tone: "attention",
            heading: ATTENTION_HEADING,
            items: gaps.client.map(describeGap),
            lines,
            links,
        });
    }

    if (gaps.autonoma.length > 0) {
        const hasPlanMismatch = gaps.autonoma.some((gap) => gap.category === ANALYSIS_VERDICT.plan_mismatch);
        const why = hasPlanMismatch ? `${OUR_SIDE_WHY} ${PLAN_MISMATCH_NOTE}` : OUR_SIDE_WHY;
        notes.push({
            tone: "quiet",
            heading: OUR_SIDE_HEADING,
            items: gaps.autonoma.map(describeGap),
            lines: [why],
            links: [],
        });
    }

    // A removal is a conclusion, not a problem: one quiet line, in neither owner's block.
    const removed = countFor(input.coverage, ANALYSIS_VERDICT.invalid_test);
    if (removed > 0) {
        notes.push({ tone: "quiet", items: [], lines: [describeRemovedTests(removed)], links: [] });
    }

    return notes;
}

/** The removed-test line: a deliberate, evidence-backed removal, stated once and left alone. */
function describeRemovedTests(count: number): string {
    const noun = describeCount(ANALYSIS_VERDICT.invalid_test, count);
    return `${noun} removed - ${count === 1 ? REMOVED_TEST_WHY : REMOVED_TESTS_WHY}.`;
}

/** One coverage gap group as a block reports it: how many tests, and which wording explains it. */
interface CoverageGap {
    category: AnalysisVerdict;
    count: number;
    /** Overrides the category's default explanation - the infra-side reading of an `environment_failure`. */
    explanation?: string;
}

interface PartitionedCoverageGaps {
    client: CoverageGap[];
    autonoma: CoverageGap[];
}

/**
 * Split the run's coverage gaps between the two owners. Every category but `environment_failure` is owned by the
 * taxonomy itself; env gaps are split by the Reporter's own count of the ones it traced to fixable configuration,
 * clamped to the category's total so a stale count can never invent gaps. `invalid_test` belongs to neither block.
 */
function partitionCoverageGaps(input: AnalysisCommentInput): PartitionedCoverageGaps {
    const partitioned: PartitionedCoverageGaps = { client: [], autonoma: [] };
    for (const entry of input.coverage?.byCategory ?? []) {
        if (entry.count <= 0) continue;
        const owner = analysisCoverageOwner(entry.category);
        if (owner === "client") {
            partitioned.client.push({ category: entry.category, count: entry.count });
            continue;
        }
        if (owner === "autonoma") {
            partitioned.autonoma.push({ category: entry.category, count: entry.count });
            continue;
        }
        // `invalid_test` owns no block at all; it is reported as a removal instead.
        if (owner !== "undecided") continue;

        // `environment_failure`: the reader's share is what the Reporter placed, the rest is ours.
        const onClient = Math.min(Math.max(input.clientEnvironmentFailures ?? 0, 0), entry.count);
        if (onClient > 0) partitioned.client.push({ category: entry.category, count: onClient });
        const onUs = entry.count - onClient;
        if (onUs > 0) {
            partitioned.autonoma.push({
                category: entry.category,
                count: onUs,
                explanation: OUR_ENVIRONMENT_EXPLANATION,
            });
        }
    }
    return partitioned;
}

/** One gap as a bullet: how many tests it cost, and what it means. */
function describeGap(gap: CoverageGap): string {
    const explanation = gap.explanation ?? COVERAGE_CATEGORY_EXPLANATION[gap.category];
    return `${describeCount(gap.category, gap.count)} - ${explanation}.`;
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
