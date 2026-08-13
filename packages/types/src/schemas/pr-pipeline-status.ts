import { z } from "zod";
import { checkpointPresentationSummarySchema } from "./checkpoint-summary";

/**
 * Rolled-up "PR health at a glance", shared by the pull-request list, the PR-page header, and the
 * main-branch header so every surface shows the same state. A single discriminated value describing
 * where a branch sits in the deploy -> analyze pipeline:
 *
 * - `checkpoint`      - the last completed analysis reflects the current commit; render its summary.
 * - `building`        - the preview environment is building/deploying a commit not yet analyzed.
 * - `pending_checks`  - the preview is ready on a commit whose analysis has not started yet.
 * - `analyzing`       - an analysis (diff/checks) is running (the only new-commit signal clients
 *                       with an external, off-platform deploy emit).
 * - `analysis_failed` - the newest analysis run died on the current commit, so this PR has no verdict.
 * - `build_failed`    - the preview build failed on a commit not yet analyzed.
 * - `deploy_failed`   - the images built, but a workload never came up (a crash on startup, a missing
 *                       dependency). Distinct from `build_failed` because it sends the reader somewhere
 *                       else entirely: a build failure is explained by the build logs, a rollout failure
 *                       by the app's own runtime logs.
 * - `none`            - nothing to show yet.
 *
 * The backend derives this from SHA-equality between the preview environment's commit and the branch's
 * newest analysis run - never timestamps. See `computePrPipelineStatus`.
 */
export const prPipelineStatusSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("checkpoint"), summary: checkpointPresentationSummarySchema }),
    z.object({ kind: z.literal("building") }),
    z.object({ kind: z.literal("pending_checks") }),
    z.object({ kind: z.literal("analyzing") }),
    z.object({ kind: z.literal("analysis_failed") }),
    z.object({ kind: z.literal("build_failed") }),
    z.object({ kind: z.literal("deploy_failed") }),
    z.object({ kind: z.literal("none") }),
]);
export type PrPipelineStatus = z.infer<typeof prPipelineStatusSchema>;
