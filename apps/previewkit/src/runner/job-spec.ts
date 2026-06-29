import type { PreviewDeployEvent } from "@autonoma/types";
import { z } from "zod";

/**
 * The payload a deploy/teardown runner Job carries in its PREVIEWKIT_JOB_SPEC
 * env var. The API's PreviewkitJobLauncher writes it; this is the process
 * boundary where it is parsed and Zod-validated (the JSON crosses from the Job
 * spec into the runner as untrusted input, so it is checked rather than
 * trusted).
 *
 * Contract: keep `event` in sync with `PreviewDeployEvent` (`@autonoma/types`)
 * - the `satisfies` below fails the build if the schema drifts from the
 * interface - and with the object the launcher builds in
 * `apps/api/src/previewkit/previewkit-job-launcher.ts`.
 */
const previewDeployEventSchema = z.object({
    action: z.enum(["opened", "synchronize", "closed", "reopened", "ready_for_review"]),
    prNumber: z.number().int(),
    repoFullName: z.string().min(1),
    organizationId: z.string().min(1),
    githubRepositoryId: z.number().int(),
    headSha: z.string(),
    headRef: z.string(),
    baseSha: z.string(),
    baseRef: z.string(),
    cloneUrl: z.string(),
}) satisfies z.ZodType<PreviewDeployEvent>;

const previewJobSpecSchema = z.discriminatedUnion("mode", [
    z.object({
        mode: z.literal("deploy"),
        event: previewDeployEventSchema,
        configRevisionId: z.string().optional(),
    }),
    z.object({
        mode: z.literal("teardown"),
        event: previewDeployEventSchema,
    }),
    // Per-app redeploy: namespace comes from the env row (resolved by the API
    // trigger), not from `prepare`. `rebuild` re-builds + redeploys the one app;
    // `restart` re-rolls its pods.
    z.object({
        mode: z.literal("redeploy-app"),
        event: previewDeployEventSchema,
        namespace: z.string().min(1),
        appName: z.string().min(1),
        redeployMode: z.enum(["rebuild", "restart"]),
        configRevisionId: z.string().optional(),
    }),
]);

export type PreviewJobSpec = z.infer<typeof previewJobSpecSchema>;

/**
 * Parses + validates the raw PREVIEWKIT_JOB_SPEC env value. Throws (which the
 * runner surfaces as a non-zero exit) when it is missing or malformed - a
 * misconfigured Job should fail loudly, not silently no-op.
 */
export function parseJobSpec(raw: string | undefined): PreviewJobSpec {
    if (raw == null || raw === "") {
        throw new Error("PREVIEWKIT_JOB_SPEC is required for a preview runner Job but was empty");
    }
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (err) {
        throw new Error(`PREVIEWKIT_JOB_SPEC is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return previewJobSpecSchema.parse(json);
}
