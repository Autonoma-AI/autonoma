import { z } from "zod";
import { suspectedCauseSchema } from "./suspected-cause";

export const generationVerdictKindSchema = z.enum([
    "success",
    "agent_limitation",
    "application_bug",
    "plan_mismatch",
    "unknown_issue",
]);
export type GenerationVerdictKind = z.infer<typeof generationVerdictKindSchema>;

export const GENERATION_FAILURE_VERDICTS = [
    "agent_limitation",
    "application_bug",
    "plan_mismatch",
    "unknown_issue",
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

/**
 * The flat wire shape of a generation verdict - the schema the reviewer's
 * `submit_verdict` tool actually exposes to the model.
 *
 * It stays a flat object (not a discriminated union) on purpose: Gemini
 * function-calling requires tool `parameters` to be a root OBJECT schema and
 * rejects the `oneOf` that a discriminated union compiles to. {@link
 * generationVerdictSchema} pipes this flat shape into the discriminated union
 * below, so the model sees an object while consumers get per-kind narrowing.
 * Per-kind required fields (e.g. `suspectedCause` on `application_bug`) live
 * here as optional fields and are enforced by the union pipe.
 */
const generationVerdictBaseSchema = z.object({
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
    suspectedCause: suspectedCauseSchema
        .optional()
        .describe(
            "REQUIRED for 'application_bug': the concrete code cause grounding the bug (>= 1 code reference). If you cannot ground the bug in code, classify it as 'unknown_issue' instead. Ignored for other verdicts.",
        ),
});

const successVerdictSchema = generationVerdictBaseSchema.extend({ verdict: z.literal("success") });
const agentLimitationVerdictSchema = generationVerdictBaseSchema.extend({ verdict: z.literal("agent_limitation") });
const applicationBugVerdictSchema = generationVerdictBaseSchema.extend({
    verdict: z.literal("application_bug"),
    suspectedCause: suspectedCauseSchema,
});
const planMismatchVerdictSchema = generationVerdictBaseSchema.extend({ verdict: z.literal("plan_mismatch") });
const unknownIssueVerdictSchema = generationVerdictBaseSchema.extend({ verdict: z.literal("unknown_issue") });

const generationVerdictUnionSchema = z.discriminatedUnion("verdict", [
    successVerdictSchema,
    agentLimitationVerdictSchema,
    applicationBugVerdictSchema,
    planMismatchVerdictSchema,
    unknownIssueVerdictSchema,
]);

/**
 * A reviewer's generation verdict. The wire schema sent to the model is the
 * flat {@link generationVerdictBaseSchema} (Gemini-compatible); parsing pipes it
 * into a discriminated union on `verdict`, so the inferred type narrows per kind
 * for consumers and future slices can attach per-kind required fields.
 */
export const generationVerdictSchema = generationVerdictBaseSchema.pipe(generationVerdictUnionSchema);

export type GenerationVerdict = z.infer<typeof generationVerdictSchema>;
