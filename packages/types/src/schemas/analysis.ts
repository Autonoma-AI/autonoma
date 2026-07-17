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

/**
 * The terminal verdict an Investigator emits for one test - the complete taxonomy the merged pipeline resolves
 * every run to. Two planes:
 *
 * - App-health: `client_bug` (the app misbehaved - the only true positive against the PR) and `passed`. This
 *   plane drives the PR's headline verdict.
 * - Coverage-confidence: `engine_artifact` (a harness/engine fault - flake, crash, timeout), `environment_failure`
 *   (the preview/infra was unavailable), `scenario_issue` (the test data was mis-seeded), and `delete` (a
 *   correct app whose test could not be stabilized, so the Investigator deleted its own row). This plane never
 *   counts as a bug against the PR and never blocks the run.
 *
 * `delete` is not a classifier output: the Investigator resolves it when a `test_is_wrong` self-heal loop
 * exhausts on a healthy app (the final iteration disallows another rewrite). ONE terminal covers both an
 * un-fixable affected test and an un-stabilizable new test - the report tells them apart from data (was the
 * plan pinned by the snapshot or authored this run), not a separate verdict. There is deliberately no "unknown"
 * bucket: a fault the Investigator cannot classify resolves to `engine_artifact`, never to a silent drop.
 *
 * `test_is_wrong` (the old `outdated_test` + `bad_test`, collapsed) is intentionally absent - it is a TRANSIENT
 * loop-routing signal inside the Investigator, never emitted as a finding.
 */
export const analysisVerdictSchema = z.enum([
    "passed",
    "client_bug",
    "engine_artifact",
    "environment_failure",
    "scenario_issue",
    "delete",
]);
export type AnalysisVerdict = z.infer<typeof analysisVerdictSchema>;

/**
 * How a test entered the analysis run - the data tag that tells a `delete` finding apart:
 *
 * - `pre_existing`: an affected test the PR's diff touched (Impact Analysis marked it via `RegenerateSteps`). Its
 *   global TestCase is a real suite member, so a `delete` removes only this run's assignment.
 * - `proposed`: a brand-new test Impact Analysis authored this run for functionality the PR adds (via `AddTest`).
 *   Its TestCase exists only for this run, so a `delete` removes the whole TestCase, not just the assignment.
 *
 * Carried onto every candidate finding so the report can narrate the two apart ("couldn't establish N proposed
 * tests" vs "removed N obsolete tests") and so the Investigator's self-delete cleans up the right rows.
 */
export const analysisTestOriginSchema = z.enum(["pre_existing", "proposed"]);
export type AnalysisTestOrigin = z.infer<typeof analysisTestOriginSchema>;
