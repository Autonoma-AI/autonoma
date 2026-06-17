import { z } from "zod";

export const IntrospectRepositoryInputSchema = z.object({
    applicationId: z.string(),
    /** Introspect a specific (dependency) repo instead of the Application's linked primary repo. */
    githubRepositoryId: z.number().int().positive().optional(),
});

export type IntrospectRepositoryInput = z.infer<typeof IntrospectRepositoryInputSchema>;

export const SuggestedAppSchema = z.object({
    name: z.string(),
    path: z.string(),
    dockerfile: z.string().optional(),
    monorepo: z.enum(["turbo"]).optional(),
    port: z.number().int().positive().optional(),
    command: z.string().optional(),
    confidence: z.enum(["high", "medium", "low"]),
    /** Human-readable hints behind the suggestion, e.g. `Dockerfile at apps/web/Dockerfile`. */
    evidence: z.array(z.string()),
});

export type SuggestedApp = z.infer<typeof SuggestedAppSchema>;

export const RepoIntrospectionSchema = z.object({
    /** `unavailable` means GitHub could not be reached or read - manual setup must proceed. */
    status: z.enum(["ok", "unavailable"]),
    reason: z.string().optional(),
    repo: z
        .object({
            githubRepositoryId: z.number().int(),
            fullName: z.string(),
            defaultBranch: z.string(),
            headSha: z.string(),
        })
        .optional(),
    monorepoTool: z.enum(["turbo", "pnpm-workspace", "npm-workspace"]).optional(),
    apps: z.array(SuggestedAppSchema),
    /** Every Dockerfile path detected in the repo, for dockerfile pickers. */
    dockerfiles: z.array(z.string()),
});

export type RepoIntrospection = z.infer<typeof RepoIntrospectionSchema>;
