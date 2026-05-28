import { z } from "zod";

export const AFFECTED_REASONS = ["code_change", "merge_plan_imported", "merge_conflict"] as const;

export const affectedReasonSchema = z.enum(AFFECTED_REASONS);

export type AffectedReason = z.infer<typeof affectedReasonSchema>;

export const affectedTestSchema = z.object({
    slug: z.string().describe("The exact slug of the affected test from the Existing Tests list"),
    testName: z.string().describe("The name of the test"),
    affectedReason: affectedReasonSchema.describe("Structured reason this test is affected"),
    reasoning: z.string().describe("Why this test might be affected by the code changes"),
});

export type AffectedTest = z.infer<typeof affectedTestSchema>;
