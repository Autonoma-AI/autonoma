import { z } from "zod";

export const generationVerdictKindSchema = z.enum(["success", "agent_limitation", "application_bug", "plan_mismatch"]);
export type GenerationVerdictKind = z.infer<typeof generationVerdictKindSchema>;

export const GENERATION_FAILURE_VERDICTS = [
    "agent_limitation",
    "application_bug",
    "plan_mismatch",
] as const satisfies readonly Exclude<GenerationVerdictKind, "success">[];

export const reviewEvidenceSchema = z.object({
    type: z.enum(["conversation", "screenshot", "video", "step_output"]),
    description: z.string(),
    s3Key: z.string().optional().describe("S3 key for the associated media asset (screenshot or video)"),
});
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;

export const failurePointSchema = z.object({
    stepOrder: z.number().optional().describe("The step where the failure occurred, if identifiable"),
    description: z.string().describe("What happened at the point of failure"),
});
export type FailurePoint = z.infer<typeof failurePointSchema>;

export const generationVerdictSchema = z.object({
    verdict: generationVerdictKindSchema.describe(
        "Reviewer's authoritative classification of this generation. Use 'success' when the generation truly completed the test plan; otherwise pick the failure cause.",
    ),
    title: z
        .string()
        .describe("Short, bug-report-style title (under 100 chars). For 'success', describe the verified behavior."),
    reasoning: z.string().describe("Detailed explanation of the verdict"),
    failurePoint: failurePointSchema.describe(
        "Where the failure occurred. For 'success', use this to indicate the final completed step.",
    ),
    evidence: z.array(reviewEvidenceSchema).describe("Supporting evidence from the analysis"),
});

export type GenerationVerdict = z.infer<typeof generationVerdictSchema>;
