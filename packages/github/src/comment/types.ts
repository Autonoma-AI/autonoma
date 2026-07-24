import { z } from "zod";

export const AutonomaCommentStateSchema = z.enum([
    "running",
    "healthy",
    "incomplete",
    "warning",
    "critical",
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
    previewHref: z.string().optional(),
});
export type AutonomaCommentBug = z.infer<typeof AutonomaCommentBugSchema>;

export const AutonomaCommentServiceSchema = z.object({
    name: z.string(),
    status: z.enum(["ready", "failed", "building", "skipped", "unknown"]),
    url: z.string().optional(),
    error: z.string().optional(),
});
export type AutonomaCommentService = z.infer<typeof AutonomaCommentServiceSchema>;

export const AutonomaCommentAddonSchema = z.object({
    name: z.string(),
    provider: z.string(),
    status: z.enum(["ready", "failed"]),
});
export type AutonomaCommentAddon = z.infer<typeof AutonomaCommentAddonSchema>;

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
 * The "hand off to a coding agent" block. `prompt` is the full, paste-ready brief (findings + evidence)
 * shown in a copy-buttoned code fence; `links` are "open in <agent>" deep-links that prefill a short
 * kickoff prompt (review-and-send, never auto-run). Absent on comments with no findings.
 */
export const AutonomaCommentHandoffSchema = z.object({
    prompt: z.string(),
    links: z.array(AutonomaCommentCtaSchema).default([]),
});
export type AutonomaCommentHandoff = z.infer<typeof AutonomaCommentHandoffSchema>;

export const AutonomaCommentPayloadSchema = z.object({
    state: AutonomaCommentStateSchema,
    prNumber: z.number().int().positive(),
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
    addons: z.array(AutonomaCommentAddonSchema).default([]),
    bugs: z.array(AutonomaCommentBugSchema).default([]),
    warnings: z.array(z.string()).default([]),
    details: z.array(z.object({ summary: z.string(), body: z.string() })).default([]),
    handoff: AutonomaCommentHandoffSchema.optional(),
});
export type AutonomaCommentPayload = z.infer<typeof AutonomaCommentPayloadSchema>;

export type PayloadBuilderInput = {
    state: AutonomaCommentState;
    prNumber: number;
    commitSha?: string;
    duration?: string;
    assetBaseUrl?: string | null;
    previewUrl?: string | null;
    summaryUrl?: string | null;
    services?: AutonomaCommentService[];
    addons?: AutonomaCommentAddon[];
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
