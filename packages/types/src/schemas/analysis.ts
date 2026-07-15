import { z } from "zod";

/**
 * The mode the merged analysis pipeline runs in.
 *
 * - `shadow`: inert to production. Runs on a detached twin snapshot in parallel with the diffs job, never
 *   promotes a snapshot and files no user-facing rows - it only observes (logs + a DeployedComparison against
 *   the authoritative diffs output). This is the transitional mode while the pipeline is validated against diffs.
 * - `authoritative`: the production mode (dormant until the cutover) - promotes the snapshot and files real bugs.
 */
export const analysisModeSchema = z.enum(["shadow", "authoritative"]);
export type AnalysisMode = z.infer<typeof analysisModeSchema>;
