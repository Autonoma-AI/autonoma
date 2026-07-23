import { z } from "zod";

/**
 * The structured shape of an investigation-agent report, as the UI consumes it. The investigation worker
 * persists this (as JSON) next to the human-readable markdown, and the API re-signs the media URLs and serves
 * it to the in-app "View investigation" page. Category is a plain string (not an enum) on purpose: the report
 * is a DISPLAY contract that must also survive legacy/foreign verdict labels and classification-error
 * sections - the UI maps the known categories to styles and falls back gracefully for the rest.
 */
export const investigationEvidenceSchema = z.object({
    source: z.string(),
    detail: z.string(),
    file: z.string().optional(),
    lines: z.string().optional(),
    snippet: z.string().optional(),
});
export type InvestigationEvidence = z.infer<typeof investigationEvidenceSchema>;

const investigationPointSchema = z.object({ x: z.number(), y: z.number() });

/**
 * One step of the run's structured trace: the interaction, its status, and - crucially - the frame the agent
 * captured for that step plus any click/drag coordinates, so a reviewer can SEE what the app showed and where
 * the agent acted (not just trust a line that says "success"). The point coordinates are in the screenshot's
 * own pixel space, so the overlay marker needs no separate resolution. Screenshot carries the raw s3:// key at
 * persist time; the API signs it on read (like the finding's other media).
 */
export const investigationRunStepSchema = z.object({
    order: z.number(),
    interaction: z.string(),
    status: z.string(),
    error: z.string().optional(),
    screenshotUrl: z.string().optional(),
    point: investigationPointSchema.optional(),
    startPoint: investigationPointSchema.optional(),
    endPoint: investigationPointSchema.optional(),
});
export type InvestigationRunStep = z.infer<typeof investigationRunStepSchema>;

export const investigationFindingSchema = z.object({
    /** Stable per-report id for routing (the slug, suffixed when a slug appears more than once). */
    id: z.string(),
    slug: z.string(),
    category: z.string(),
    confidence: z.string().optional(),
    planFidelity: z.string().optional(),
    headline: z.string(),
    whatHappened: z.string().optional(),
    /** App problems seen in the run independent of this test's pass/fail. */
    observedAppIssues: z.string().optional(),
    remediation: z.string().optional(),
    rootCause: z.string().optional(),
    falsePositiveRisk: z.string().optional(),
    /** A ready-to-render unified diff of the agent's proposed test-plan change (no code fences). */
    suggestedFixDiff: z.string().optional(),
    evidence: z.array(investigationEvidenceSchema),
    /** The test plan the run was checked against (the "reproduction" steps). */
    plan: z.string().optional(),
    runSuccess: z.boolean().optional(),
    stepCount: z.number().optional(),
    /**
     * The step-by-step trace of what the run ACTUALLY did - each step's interaction, status, and per-step
     * error (e.g. "click OK ... failed"). This is the run agent's own observation log, embedded so a reader
     * can audit the verdict against what happened on screen instead of trusting the narrative. Absent on
     * legacy reports written before the trace was surfaced.
     */
    runSteps: z.array(z.string()).optional(),
    /**
     * The structured, inspectable version of the trace: each step with its captured frame + click coordinates,
     * so the finding page can render a hoverable trace where a reviewer opens the screenshot and sees exactly
     * where the agent clicked. Populated alongside `runSteps` (which stays as the text fallback); absent on
     * legacy reports written before the structured trace was surfaced.
     */
    runTrace: z.array(investigationRunStepSchema).optional(),
    /** Browser-openable HTTPS URL (the API signs the stored s3:// key on read). */
    videoUrl: z.string().optional(),
    /** Browser-openable HTTPS URL of the dead-time-stripped mp4 recording, signed on read. When present, the
     *  finding page shows an Optimized/Original toggle; absent for runs recorded before the optimizer landed. */
    optimizedVideoUrl: z.string().optional(),
    finalScreenshotUrl: z.string().optional(),
    /** Present instead of the verdict fields when the model failed to classify this test. */
    error: z.string().optional(),
    /**
     * When the reconciliation agent MERGED several tests that surfaced the same underlying issue into this one
     * finding, the slugs of every test it represents (its own slug plus the absorbed ones). Length > 1 means
     * this is a merged finding (its narrative + evidence combine all of them); absent/length 1 means standalone.
     */
    coveredSlugs: z.array(z.string()).optional(),
});
export type InvestigationFinding = z.infer<typeof investigationFindingSchema>;

export const investigationValidationSchema = z.object({
    passed: z.boolean(),
    iterations: z.number(),
    failureReason: z.string().optional(),
});

export const investigationSuggestedTestSchema = z.object({
    name: z.string(),
    instruction: z.string(),
    reasoning: z.string(),
    validation: investigationValidationSchema.optional(),
});
export type InvestigationSuggestedTest = z.infer<typeof investigationSuggestedTestSchema>;

export const investigationDeployedPerTestSchema = z.object({
    testSlug: z.string(),
    affectedReason: z.string().optional(),
    runStatus: z.string().optional(),
    generatedFix: z.boolean().optional(),
});

export const investigationDeployedComparisonSchema = z.object({
    found: z.boolean(),
    jobStatus: z.string().optional(),
    analysisReasoning: z.string().optional(),
    resolutionReasoning: z.string().optional(),
    failureReason: z.string().optional(),
    perTest: z.array(investigationDeployedPerTestSchema),
});
export type InvestigationDeployedComparison = z.infer<typeof investigationDeployedComparisonSchema>;

export const investigationReportDataSchema = z.object({
    client: z.string(),
    appSlug: z.string(),
    prNumber: z.number(),
    prTitle: z.string().optional(),
    prBody: z.string().optional(),
    /** owner/repo for the app's GitHub repository - used to build code permalinks. Absent on legacy reports. */
    repoFullName: z.string().optional(),
    /** The PR head commit the run tested - the permalink ref. Absent on legacy reports. */
    commitSha: z.string().optional(),
    findings: z.array(investigationFindingSchema),
    suggested: z.array(investigationSuggestedTestSchema),
    deployed: investigationDeployedComparisonSchema.optional(),
});
export type InvestigationReportData = z.infer<typeof investigationReportDataSchema>;
