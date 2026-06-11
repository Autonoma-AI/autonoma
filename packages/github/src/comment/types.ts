import { z } from "zod";

export const AutonomaCommentStateSchema = z.enum(["running", "healthy", "critical", "unknown"]);
export type AutonomaCommentState = z.infer<typeof AutonomaCommentStateSchema>;

export const AutonomaCommentCtaSchema = z.object({
    label: z.string(),
    href: z.string(),
});
export type AutonomaCommentCta = z.infer<typeof AutonomaCommentCtaSchema>;

export const AutonomaCommentBugSchema = z.object({
    title: z.string(),
    href: z.string().optional(),
    severity: z.string().optional(),
    occurrenceCount: z.number().int().positive().optional(),
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
    selected: z.number().int().nonnegative().optional(),
    passed: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
    skipped: z.number().int().nonnegative().optional(),
});
export type AutonomaCommentStats = z.infer<typeof AutonomaCommentStatsSchema>;

export const AutonomaCommentPayloadSchema = z.object({
    state: AutonomaCommentStateSchema,
    prNumber: z.number().int().positive(),
    headline: z.string(),
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
        selected?: number;
        passed?: number;
        failed?: number;
        skipped?: number;
    };
    message?: string;
    details?: Array<{ summary: string; body: string }>;
    warnings?: string[];
};

export type GitHubCommentClient = {
    postComment(repoFullName: string, prNumber: number, body: string): Promise<string>;
    updateComment(repoFullName: string, commentId: string, body: string): Promise<void>;
};

export type GitHubCommentStore = {
    getState(
        repoFullName: string,
        prNumber: number,
    ): Promise<{ commentId: string | null; headSha: string | null } | null>;
    setCommentId(repoFullName: string, prNumber: number, commentId: string): Promise<void>;
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
};

export type PostOrUpdateCommentResult =
    | { status: "posted"; commentId: string; body: string }
    | { status: "updated"; commentId: string; body: string }
    | { status: "stale_skipped"; storedHeadSha: string; incomingHeadSha: string };
