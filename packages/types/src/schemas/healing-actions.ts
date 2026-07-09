import { z } from "zod";
import { authoredIssueReportSchema, issueReportSchema } from "./issue-report";
import { suspectedCauseSchema } from "./suspected-cause";

const reviewSeveritySchema = z.enum(["critical", "high", "medium", "low"]);

/**
 * How the healing agent designates the hero's primary screenshot: not a raw
 * storage key (the model never sees one) but a reference into the evidence it
 * fetched - the failing test's step order plus which captured frame. The tool
 * resolves this against that step's real screenshots to the persisted
 * `primaryScreenshotSchema` ({ s3Key, pin? }), so a hallucinated key can never
 * reach the report. `pin` is derived from the step's resolved point at that
 * time, not authored here.
 */
export const primaryScreenshotRefSchema = z.object({
    stepOrder: z
        .number()
        .int()
        .min(0)
        .describe("The step order (from the failure's Execution steps / fetch_step_evidence) whose frame to feature."),
    timing: z
        .enum(["before", "after"])
        .describe("Which captured frame of that step best shows the bug: the screenshot before or after the step ran."),
});
export type PrimaryScreenshotRef = z.infer<typeof primaryScreenshotRefSchema>;

const evidenceItemSchema = z.object({
    type: z.enum(["screenshot", "video", "conversation", "step_output"]),
    description: z.string(),
    s3Key: z.string().optional(),
});

export type HealingEvidenceItem = z.infer<typeof evidenceItemSchema>;

/**
 * The source review a report action links its evidence to. Deterministic
 * metadata about the failure (not authored by the model): a failure surfaced
 * at generation links to its generation review.
 */
export const healingReviewLinkSchema = z.object({ generationReviewId: z.string() });

export type HealingReviewLink = z.infer<typeof healingReviewLinkSchema>;

const updatePlanActionSchema = z.object({
    kind: z.literal("update_plan"),
    planId: z.string().describe("ID of the test plan to update"),
    testCaseId: z.string().describe("ID of the test case the plan belongs to"),
    newPrompt: z.string().describe("Replacement plan prompt - the natural language test instruction"),
    reasoning: z.string().describe("Why this rewrite addresses the failure"),
});

const reportBugActionSchema = z.object({
    kind: z.literal("report_bug"),
    testCaseId: z.string().describe("ID of the test case that surfaced the bug"),
    title: z.string().describe("Short bug title"),
    description: z.string().describe("Full bug description with reproduction steps and root cause hypothesis"),
    severity: reviewSeveritySchema,
    evidence: z.array(evidenceItemSchema).describe("Screenshots, videos, step outputs supporting the bug report"),
    reasoning: z.string().describe("Why this is an application bug rather than a test or engine issue"),
    suspectedCause: suspectedCauseSchema.describe(
        "The concrete code cause you re-grounded independently (>= 1 code reference). If you cannot reproduce the cause in the checked-out code, downgrade to report_unknown_issue instead of reporting a bug.",
    ),
    // The persisted report carries the full shape (authored text + the
    // system-derived evidenceManifest the report tool attaches from the agent's
    // actual fetches). Optional so actions persisted without a report still parse
    // (loadPriorActions / eval fixtures); the tool input (reportBugInputSchema)
    // re-declares an authored (manifest-free) report as required, so every new
    // report_bug carries one and the manifest is never model-authored.
    report: issueReportSchema
        .optional()
        .describe(
            "The customer-facing, evidence-grounded report shown on the bug page: Expected vs Actual plus a rich narrative. Author it from the evidence you fetched with fetch_step_evidence, not from the plan text alone.",
        ),
    reviewLink: healingReviewLinkSchema,
});

const reportEngineLimitationActionSchema = z.object({
    kind: z.literal("report_engine_limitation"),
    testCaseId: z.string().describe("ID of the test case that surfaced the limitation"),
    title: z.string(),
    description: z.string().describe("What the engine/agent could not do, and why no workaround is feasible"),
    severity: reviewSeveritySchema,
    evidence: z.array(evidenceItemSchema),
    reasoning: z.string(),
    reviewLink: healingReviewLinkSchema,
});

const reportUnknownIssueActionSchema = z.object({
    kind: z.literal("report_unknown_issue"),
    testCaseId: z.string().describe("ID of the test case that surfaced the suspected issue"),
    title: z.string(),
    description: z
        .string()
        .describe("What the application appeared to do wrong, and why the cause could not be grounded in the code"),
    severity: reviewSeveritySchema,
    evidence: z.array(evidenceItemSchema),
    reasoning: z
        .string()
        .describe("Why this is a suspected issue you could not ground in code rather than a confirmed application bug"),
    reviewLink: healingReviewLinkSchema,
});

const reportScenarioUnsupportedActionSchema = z.object({
    kind: z.literal("report_scenario_unsupported"),
    testCaseId: z.string().describe("ID of the test case that is impossible given the current scenario data"),
    title: z.string(),
    description: z
        .string()
        .describe(
            "What the test needs that the scenario data cannot currently provide, with the proposed scenario extension woven in as prose - surfaced verbatim to a human, who decides whether to extend the scenario",
        ),
    severity: reviewSeveritySchema,
    evidence: z.array(evidenceItemSchema),
    reasoning: z
        .string()
        .describe(
            "Why this test is impossible given the current scenario data (a true data gap) rather than a stale plan that should be rewritten",
        ),
    reviewLink: healingReviewLinkSchema,
});

const removeTestActionSchema = z.object({
    kind: z.literal("remove_test"),
    testCaseId: z.string().describe("ID of the test case to delete from the suite"),
    reason: z
        .string()
        .describe(
            "Why this test should be removed: either it is invalid (not a viable flow, never useful without becoming a different test) or its feature was deleted from the app",
        ),
    evidence: z
        .array(evidenceItemSchema)
        .optional()
        .describe("Optional screenshots, videos, step outputs supporting the removal"),
    reviewLink: healingReviewLinkSchema,
});

export const healingActionSchema = z.discriminatedUnion("kind", [
    updatePlanActionSchema,
    reportBugActionSchema,
    reportEngineLimitationActionSchema,
    reportUnknownIssueActionSchema,
    reportScenarioUnsupportedActionSchema,
    removeTestActionSchema,
]);

export type HealingAction = z.infer<typeof healingActionSchema>;
export type UpdatePlanAction = z.infer<typeof updatePlanActionSchema>;
export type ReportBugAction = z.infer<typeof reportBugActionSchema>;
export type ReportEngineLimitationAction = z.infer<typeof reportEngineLimitationActionSchema>;
export type ReportUnknownIssueAction = z.infer<typeof reportUnknownIssueActionSchema>;
export type ReportScenarioUnsupportedAction = z.infer<typeof reportScenarioUnsupportedActionSchema>;
export type RemoveTestAction = z.infer<typeof removeTestActionSchema>;

/**
 * The report shape the model authors: the authored text core (expected/actual/
 * narrative, with inline `evidence:<assetId>` tokens) plus a `primaryScreenshot`
 * step reference the tool resolves to a real `{ s3Key, pin? }`. The model never
 * handles storage keys, and it never authors the `evidenceManifest` - that is
 * derived from its real fetches by the report tool.
 */
export const issueReportInputSchema = authoredIssueReportSchema.extend({
    primaryScreenshot: primaryScreenshotRefSchema
        .optional()
        .describe(
            "Optional: the frame that best shows the bug, referenced by the step you inspected with fetch_step_evidence (its order + before/after). Designate one when a step's frame shows the bug more clearly than the mechanical failing step; omit it to let the page fall back to the failing-step screenshot. Do not invent a step you did not fetch.",
        ),
});
export type IssueReportInput = z.infer<typeof issueReportInputSchema>;

export const updatePlanInputSchema = updatePlanActionSchema.omit({ kind: true });
// reviewLink is deterministic failure metadata attached by the runner, not authored by the model.
// `report` is re-declared required here (it is optional on the persisted action for
// backward-compatible parsing) so the model must author it on every report_bug. It uses the
// input-form report: `primaryScreenshot` is a step reference the tool resolves to a storage key,
// and there is no `evidenceManifest` - the manifest is derived from the agent's real fetches by
// the report tool, so the model can never fabricate one.
export const reportBugInputSchema = reportBugActionSchema
    .omit({ kind: true, reviewLink: true })
    .extend({ report: issueReportInputSchema });
export const reportEngineLimitationInputSchema = reportEngineLimitationActionSchema.omit({
    kind: true,
    reviewLink: true,
});
export const reportUnknownIssueInputSchema = reportUnknownIssueActionSchema.omit({
    kind: true,
    reviewLink: true,
});
export const reportScenarioUnsupportedInputSchema = reportScenarioUnsupportedActionSchema.omit({
    kind: true,
    reviewLink: true,
});
// reviewLink is attached by the runner from the failure that surfaced the problem, not authored
// by the model, so removal is always failure-driven and citable.
export const removeTestInputSchema = removeTestActionSchema.omit({ kind: true, reviewLink: true });
