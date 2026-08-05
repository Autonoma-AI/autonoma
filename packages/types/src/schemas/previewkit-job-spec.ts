import { z } from "zod";
import type { PreviewDeployTarget, PreviewRedeployTarget, PreviewTeardownTarget } from "../types/previewkit";

/**
 * The launcher parses against this before serializing, so a spec the runner would reject fails at launch rather
 * than inside a Job nobody is watching.
 */
const deployTargetSchema = z.object({
    repoFullName: z.string().min(1),
    prNumber: z.number().int().nonnegative(),
    organizationId: z.string().min(1),
    githubRepositoryId: z.number().int(),
    headSha: z.string().min(1),
    headRef: z.string().min(1),
    branchId: z.string().optional(),
}) satisfies z.ZodType<PreviewDeployTarget>;

const redeployTargetSchema = z.object({
    repoFullName: z.string().min(1),
    prNumber: z.number().int().nonnegative(),
    organizationId: z.string().min(1),
    githubRepositoryId: z.number().int(),
    headSha: z.string().min(1),
    headRef: z.string().min(1),
}) satisfies z.ZodType<PreviewRedeployTarget>;

const teardownTargetSchema = z.object({
    repoFullName: z.string().min(1),
    prNumber: z.number().int().nonnegative(),
    organizationId: z.string().min(1),
    headSha: z.string().min(1).optional(),
}) satisfies z.ZodType<PreviewTeardownTarget>;

export const previewJobSpecSchema = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("deploy"), target: deployTargetSchema }),
    z.object({ mode: z.literal("teardown"), target: teardownTargetSchema }),
    z.object({
        mode: z.literal("redeploy-app"),
        target: redeployTargetSchema,
        namespace: z.string().min(1),
        appName: z.string().min(1),
        redeployMode: z.enum(["rebuild", "restart"]),
    }),
]);

export type PreviewJobSpec = z.infer<typeof previewJobSpecSchema>;
