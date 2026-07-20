import { z } from "zod";
import {
    investigationEvidenceSchema,
    investigationFindingSchema,
    investigationRunStepSchema,
} from "./investigation-report";

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

/**
 * The rich per-test evidence an Investigator captures when it classifies a run - the classifier's full output
 * (`classifyInvestigationRun`) that the merged pipeline used to collapse to a 5-field candidate and discard. It
 * rides on every candidate finding (optional: a contained scenario/classify fault or a crashed Investigator has
 * no classifier output) so the Reconciler can persist it onto an `AnalysisFinding` row, mirroring the frozen
 * `InvestigationFinding`. Media are stored as `s3://` keys (signed on read), never raw URLs.
 */
export const analysisFindingReportSchema = z.object({
    confidence: z.string().optional(),
    whatHappened: z.string().optional(),
    rootCause: z.string().optional(),
    remediation: z.string().optional(),
    /** App problems seen in the run independent of this test's pass/fail. */
    observedAppIssues: z.string().optional(),
    /** The classifier's explicit false-positive self-check. */
    falsePositiveRisk: z.string().optional(),
    /** The test plan the run was checked against (the "reproduction" steps). */
    plan: z.string().optional(),
    runSuccess: z.boolean().optional(),
    stepCount: z.number().optional(),
    /** The run agent's per-step text trace (interaction + status + per-step error). */
    runSteps: z.array(z.string()).optional(),
    /** The structured, inspectable trace: per-step frame (`s3://` key) + click coords. */
    runTrace: z.array(investigationRunStepSchema).optional(),
    evidence: z.array(investigationEvidenceSchema).optional(),
    /** `s3://` media keys, signed on read. */
    videoKey: z.string().optional(),
    screenshotKey: z.string().optional(),
    /** Short GIF clip of the failure (client bugs only), signed on read. */
    clipKey: z.string().optional(),
    /** Present instead of the verdict fields when the model failed to classify this test. */
    error: z.string().optional(),
});
export type AnalysisFindingReport = z.infer<typeof analysisFindingReportSchema>;

/**
 * The authoritative analysis report as the snapshot page consumes it: the merged pipeline's per-run
 * `AnalysisReport` header plus its `AnalysisFinding` children, re-signed for display. The findings reuse the
 * `investigationFindingSchema` display shape so the snapshot page renders them with the same findings-list and
 * evidence-detail components (repointed at the analysis store); the analysis-only signals (`planEdited`, origin,
 * clip) are not surfaced here. `category` is the terminal `AnalysisVerdict` as a plain string - the UI maps the
 * known verdicts to styles and falls back gracefully, matching the investigation display contract.
 *
 * The presence of this report (non-null) is the page-level gate: a snapshot with one renders the authoritative
 * layout, otherwise the diffs UI is left untouched.
 */
export const analysisReportDataSchema = z.object({
    /** The Impact Analysis stage's account of why it selected the tests it did (feeds IMPACT ANALYSIS). */
    impactReasoning: z.string().optional(),
    /** The constrained prose narration of the two-plane verdict (feeds FINDINGS SUMMARY). */
    narration: z.string().optional(),
    findings: z.array(investigationFindingSchema),
});
export type AnalysisReportData = z.infer<typeof analysisReportDataSchema>;
