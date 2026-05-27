import { z } from "zod";

const reviewSeveritySchema = z.enum(["critical", "high", "medium", "low"]);

const evidenceItemSchema = z.object({
    type: z.enum(["screenshot", "video", "conversation", "step_output"]),
    description: z.string(),
    s3Key: z.string().optional(),
});

export type HealingEvidenceItem = z.infer<typeof evidenceItemSchema>;

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
});

const reportEngineLimitationActionSchema = z.object({
    kind: z.literal("report_engine_limitation"),
    testCaseId: z.string().describe("ID of the test case that surfaced the limitation"),
    title: z.string(),
    description: z.string().describe("What the engine/agent could not do, and why no workaround is feasible"),
    severity: reviewSeveritySchema,
    evidence: z.array(evidenceItemSchema),
    reasoning: z.string(),
});

const removeTestActionSchema = z.object({
    kind: z.literal("remove_test"),
    testCaseId: z.string().describe("ID of the test case to delete from the suite"),
    reason: z.string().describe("Why this test should be removed (e.g., feature was deleted from the app)"),
});

export const healingActionSchema = z.discriminatedUnion("kind", [
    updatePlanActionSchema,
    reportBugActionSchema,
    reportEngineLimitationActionSchema,
    removeTestActionSchema,
]);

export type HealingAction = z.infer<typeof healingActionSchema>;
export type UpdatePlanAction = z.infer<typeof updatePlanActionSchema>;
export type ReportBugAction = z.infer<typeof reportBugActionSchema>;
export type ReportEngineLimitationAction = z.infer<typeof reportEngineLimitationActionSchema>;
export type RemoveTestAction = z.infer<typeof removeTestActionSchema>;

export const updatePlanInputSchema = updatePlanActionSchema.omit({ kind: true });
export const reportBugInputSchema = reportBugActionSchema.omit({ kind: true });
export const reportEngineLimitationInputSchema = reportEngineLimitationActionSchema.omit({ kind: true });
export const removeTestInputSchema = removeTestActionSchema.omit({ kind: true });
