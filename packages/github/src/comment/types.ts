import { z } from "zod";

export const AutonomaCommentStateSchema = z.enum([
    "running",
    "healthy",
    "incomplete",
    "warning",
    "critical",
    "skipped",
    "unknown",
]);
export type AutonomaCommentState = z.infer<typeof AutonomaCommentStateSchema>;

export const AutonomaCommentCtaSchema = z.object({
    label: z.string(),
    href: z.string(),
});
export type AutonomaCommentCta = z.infer<typeof AutonomaCommentCtaSchema>;

/** One evidence item shown in a bug's nested Evidence collapsible - a labelled line + an optional code snippet. */
export const AutonomaCommentEvidenceSchema = z.object({
    source: z.string(),
    detail: z.string().optional(),
    /** `owner/repo` when the cited file lives in a dependency repo; absent for the primary repo. */
    repo: z.string().optional(),
    file: z.string().optional(),
    lines: z.string().optional(),
    snippet: z.string().optional(),
});
export type AutonomaCommentEvidence = z.infer<typeof AutonomaCommentEvidenceSchema>;

export const AutonomaCommentBugSchema = z.object({
    title: z.string(),
    href: z.string().optional(),
    markerState: AutonomaCommentStateSchema.optional(),
    occurrenceCount: z.number().int().positive().optional(),
    /**
     * Rich detail (the investigation and analysis comments): when any of these are set, the bug renders as an
     * expandable `<details>` - a screenshot linking to the replay, the short description, the suspected cause or
     * remediation, and a nested Evidence collapsible for coding agents. Absent on the diffs comment, which keeps
     * bugs as one-liners.
     */
    screenshotUrl: z.string().optional(),
    replayHref: z.string().optional(),
    description: z.string().optional(),
    remediation: z.string().optional(),
    /**
     * The hedged, code-level diagnosis of what produces the misbehavior - the analysis comment's counterpart to
     * `remediation`. It says where the problem probably IS, not how to fix it; the accompanying `evidence` items
     * carry the file:line references it cites. Rendered as its own labelled line, so it is never mistaken for a
     * prescription.
     */
    suspectedCause: z.string().optional(),
    evidence: z.array(AutonomaCommentEvidenceSchema).optional(),
});
export type AutonomaCommentBug = z.infer<typeof AutonomaCommentBugSchema>;

/**
 * One grouped block of the comment body - how the analysis comment partitions its coverage gaps by OWNER: a visible
 * "needs your attention" block for gaps only the reader can fix, and a quiet one for gaps that are ours. The copy is
 * ours (never LLM-authored); `links` carry the issues a block is about.
 */
export const AutonomaCommentNoteSchema = z.object({
    /** `attention` renders as a visible bold-headed block; `quiet` renders as an unobtrusive blockquote. */
    tone: z.enum(["attention", "quiet"]),
    /** The block's bold heading. Absent on a standalone quiet line, which is a sentence and nothing more. */
    heading: z.string().optional(),
    /** What the block is about, one tight bullet per entry. */
    items: z.array(z.string()).default([]),
    /** Closing paragraphs under the bullets: why the block matters, and any lead-in for `links`. */
    lines: z.array(z.string()).default([]),
    /** Links rendered as a bullet list under the prose - the issues behind the block. */
    links: z.array(AutonomaCommentCtaSchema).default([]),
});
export type AutonomaCommentNote = z.infer<typeof AutonomaCommentNoteSchema>;

/** One flow in the analysis comment's itemization: what it is, how it went, and how much of it held up. */
export const AutonomaCommentFlowSchema = z.object({
    title: z.string(),
    detail: z.string(),
    /**
     * The flow's composition, e.g. "3 of 4 checks passed". Present whenever a flow is not wholly one thing, so a
     * partial flow is never read as a flat failure - the whole reason a flow reports a mix rather than a verdict.
     */
    meta: z.string().optional(),
});
export type AutonomaCommentFlow = z.infer<typeof AutonomaCommentFlowSchema>;

/**
 * One group of the analysis comment's flow itemization: what we verified, what the reader must fix, what is ours.
 *
 * This replaces the per-category gap counts the body used to carry ("2 engine artifacts - our runner could not
 * complete these checks"), which named no flow and reported only losses. A reader needs to know WHICH parts of their
 * app are covered, and the wins have to appear next to the gaps or the comment reads as pure loss.
 */
export const AutonomaCommentFlowGroupSchema = z.object({
    heading: z.string(),
    /** `attention` renders plainly, at the weight of the bug cards; `quiet` renders blockquoted. */
    tone: z.enum(["attention", "quiet"]),
    /** Closing paragraphs under the flows: why the group matters. */
    lines: z.array(z.string()).default([]),
    flows: z.array(AutonomaCommentFlowSchema).default([]),
    /** The issues behind the group's flows - the reader's "what to fix", in the Reporter's own words. */
    links: z.array(AutonomaCommentCtaSchema).default([]),
    /**
     * Rich issue cards rendered under the group's prose - the "yours to fix" scenario issues, each a bug-style
     * `<details>` (representative frame, "Watch replay", description, "See full report") with NO Evidence block,
     * since a setup gap carries no code evidence.
     */
    cards: z.array(AutonomaCommentBugSchema).default([]),
    /** How many flows were cut from a capped group, and where the reader sees all of them. */
    overflow: z.object({ count: z.number().int().positive(), href: z.string() }).optional(),
});
export type AutonomaCommentFlowGroup = z.infer<typeof AutonomaCommentFlowGroupSchema>;

export const AutonomaCommentServiceSchema = z.object({
    name: z.string(),
    status: z.enum(["ready", "failed", "building", "skipped", "unknown"]),
    url: z.string().optional(),
    error: z.string().optional(),
});
export type AutonomaCommentService = z.infer<typeof AutonomaCommentServiceSchema>;

export const AutonomaCommentStatsSchema = z.object({
    // Total assigned tests (shown as "Tests"); falls back to `selected` when absent.
    assigned: z.number().int().nonnegative().optional(),
    selected: z.number().int().nonnegative().optional(),
    passed: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
    setupFailed: z.number().int().nonnegative().optional(),
    // Unresolved / in-flight tests. `runningLabel` carries the word for this bucket
    // ("running" vs "awaiting review") so the comment matches the UI vocabulary.
    running: z.number().int().nonnegative().optional(),
    runningLabel: z.string().optional(),
    skipped: z.number().int().nonnegative().optional(),
});
export type AutonomaCommentStats = z.infer<typeof AutonomaCommentStatsSchema>;

/**
 * Section 1 of the unified `pr` comment: a single coarse status line for the branch's preview environment - present
 * only for previewkit orgs, whose preview Autonoma builds. `status` is our copy for the current build state; `link`
 * points at the reachable preview (front door) when there is one. The full per-service breakdown lives on the in-app
 * preview page, never here.
 */
export const AutonomaCommentPreviewSchema = z.object({
    state: AutonomaCommentStateSchema,
    status: z.string(),
    link: AutonomaCommentCtaSchema.optional(),
});
export type AutonomaCommentPreview = z.infer<typeof AutonomaCommentPreviewSchema>;

export const AutonomaCommentPayloadSchema = z.object({
    state: AutonomaCommentStateSchema,
    /**
     * Which comment this is, when it renders differently from the default test-run comment.
     *
     * - `preview`: the PreviewKit status comment, which renders a fixed "PreviewKit" title.
     * - `analysis`: the authoritative analysis comment, which states its own outcome in {@link title} and
     *   {@link headline} rather than through a state badge. Only a bug carries a status colour there; every other
     *   outcome is reported in words, because a run that verified six flows of seven has no honest colour.
     * - `pr`: the single Autonoma PR comment, which renders like `analysis` (outcome in words) and additionally
     *   shows a {@link preview} status section on top when the org's preview is Autonoma-hosted.
     */
    kind: z.enum(["preview", "analysis", "pr"]).optional(),
    prNumber: z.number().int().positive(),
    /**
     * Overrides the default badge word for `state`. Absent means the renderer's generic per-state label. Not rendered
     * at all on the `analysis` comment, whose title and headline carry the outcome.
     */
    stateLabel: z.string().optional(),
    /**
     * The comment's `##` heading, overriding the state-derived title. The analysis comment authors this for every
     * outcome except an open bug, which we state ourselves with a count.
     */
    title: z.string().optional(),
    headline: z.string(),
    /**
     * An optional prose paragraph rendered right under the headline - the analysis comment's constrained
     * narration of the run. LLM-authored, so it is sanitized on render. Absent on the diffs/preview/investigation
     * comments, which carry no run-level summary.
     */
    summary: z.string().optional(),
    stats: AutonomaCommentStatsSchema.optional(),
    commitRef: z.string().optional(),
    duration: z.string().optional(),
    assetBaseUrl: z.string().optional(),
    ctas: z.array(AutonomaCommentCtaSchema).default([]),
    services: z.array(AutonomaCommentServiceSchema).default([]),
    bugs: z.array(AutonomaCommentBugSchema).default([]),
    /**
     * Owner-grouped body blocks, rendered under the bug cards (the analysis comment): what the reader must fix, then
     * what is ours to chase. Empty on every other comment kind, which carries its coverage caveats in `warnings`.
     */
    notes: z.array(AutonomaCommentNoteSchema).default([]),
    /**
     * The analysis comment's flow itemization, rendered under the bug cards: what this PR has verified and what it
     * has not, in the reader's own vocabulary. Empty on every other comment kind.
     */
    flowGroups: z.array(AutonomaCommentFlowGroupSchema).default([]),
    warnings: z.array(z.string()).default([]),
    details: z.array(z.object({ summary: z.string(), body: z.string() })).default([]),
    /**
     * A hidden, agent-only block: how to read these findings live through the Autonoma MCP and re-check the PR
     * once they are fixed. Rendered as an HTML comment - invisible in GitHub's rendered view, present in the raw
     * body an agent fetches with `gh pr view --comments`.
     */
    agentHint: z.string().optional(),
    /** Section 1 of the `pr` comment: the preview environment's status line. Absent on every other comment kind. */
    preview: AutonomaCommentPreviewSchema.optional(),
    /**
     * Raw preview URLs for machines. The visible "See preview" CTA points at the
     * front door (which forks browser vs. agent), so a coding agent reading this
     * comment via `gh` would otherwise be left with no direct URL - most of all on
     * the investigation comment, whose services list is empty. Rendered as a hidden
     * HTML-comment block, invisible in GitHub's rendered view but present in the raw
     * body an agent fetches.
     */
    previewUrls: z.array(z.string()).default([]),
});
export type AutonomaCommentPayload = z.infer<typeof AutonomaCommentPayloadSchema>;

export type PayloadBuilderInput = {
    state: AutonomaCommentState;
    kind?: "preview";
    prNumber: number;
    commitSha?: string;
    duration?: string;
    assetBaseUrl?: string | null;
    previewUrl?: string | null;
    summaryUrl?: string | null;
    services?: AutonomaCommentService[];
    bugs?: AutonomaCommentBug[];
    tests?: {
        assigned?: number;
        selected?: number;
        passed?: number;
        failed?: number;
        setupFailed?: number;
        running?: number;
        runningLabel?: string;
        skipped?: number;
    };
    message?: string;
    details?: Array<{ summary: string; body: string }>;
    warnings?: string[];
    /** Raw preview URLs for the hidden machine-readable block; see the payload field. */
    previewUrls?: string[];
};

export type GitHubCommentClient = {
    postComment(repoFullName: string, prNumber: number, body: string): Promise<string>;
    updateComment(repoFullName: string, commentId: string, body: string): Promise<void>;
    // Must be idempotent: deleting an already-deleted comment (GitHub 404) resolves, not throws.
    deleteComment(repoFullName: string, commentId: string): Promise<void>;
};

export type GitHubCommentStore = {
    getState(
        repoFullName: string,
        prNumber: number,
    ): Promise<{ commentId: string | null; headSha: string | null } | null>;
    setCommentId(repoFullName: string, prNumber: number, commentId: string, headSha: string): Promise<void>;
    // Optional cross-process mutex for a single PR, wrapping the read-post-persist section so two
    // concurrent first-time completions cannot both post before either persists its id.
    runExclusive?<T>(repoFullName: string, prNumber: number, fn: () => Promise<T>): Promise<T>;
};

export type PostOrUpdateCommentInput = {
    client: GitHubCommentClient;
    store: GitHubCommentStore;
    repoFullName: string;
    prNumber: number;
    lastCommitSha: string;
    payload: AutonomaCommentPayload;
    commentId?: string | null;
    staleGuard?: "strict" | "allow-new-head";
    // "update" (default) edits the existing comment in place; "repost" deletes it and posts a
    // fresh one at the bottom of the PR. Either way, at most one comment per (repo, pr, kind).
    mode?: "update" | "repost";
};

export type PostOrUpdateCommentResult =
    | { status: "posted"; commentId: string; body: string }
    | { status: "updated"; commentId: string; body: string }
    | { status: "stale_skipped"; storedHeadSha: string; incomingHeadSha: string };
