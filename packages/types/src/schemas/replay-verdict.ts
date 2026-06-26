import { z } from "zod";
import { failurePointSchema, reviewEvidenceSchema } from "./generation-verdict";
import { suspectedCauseSchema } from "./suspected-cause";

export const replayVerdictKindSchema = z.enum(["engine_error", "application_bug", "unknown_issue"]);
export type ReplayVerdictKind = z.infer<typeof replayVerdictKindSchema>;

/**
 * The flat wire shape of a replay verdict - the schema the reviewer's
 * `submit_verdict` tool actually exposes to the model.
 *
 * Kept flat (not a discriminated union) on purpose: Gemini function-calling
 * requires tool `parameters` to be a root OBJECT schema and rejects the `oneOf`
 * that a discriminated union compiles to. {@link replayVerdictSchema} pipes this
 * flat shape into the discriminated union below, so the model sees an object
 * while consumers get per-kind narrowing.
 */
const replayVerdictBaseSchema = z.object({
    verdict: replayVerdictKindSchema.describe(
        "Root cause of the replay failure. 'engine_error' means the recorded steps no longer match the application UI; 'application_bug' means the steps are correct but the app misbehaved; 'unknown_issue' means the app likely misbehaved but the cause cannot be grounded in the checked-out code.",
    ),
    title: z.string().describe("Short, bug-report-style title (under 100 chars)"),
    reasoning: z.string().describe("Detailed explanation of the verdict"),
    failurePoint: failurePointSchema.describe("Where the failure occurred"),
    evidence: z.array(reviewEvidenceSchema).describe("Supporting evidence from the analysis"),
    suspectedCause: suspectedCauseSchema
        .optional()
        .describe(
            "REQUIRED for 'application_bug': the concrete code cause grounding the bug (>= 1 code reference). If you cannot ground the bug in code, classify it as 'unknown_issue' instead. Ignored for other verdicts.",
        ),
});

const engineErrorVerdictSchema = replayVerdictBaseSchema.extend({ verdict: z.literal("engine_error") });
const applicationBugVerdictSchema = replayVerdictBaseSchema.extend({
    verdict: z.literal("application_bug"),
    suspectedCause: suspectedCauseSchema,
});
const unknownIssueVerdictSchema = replayVerdictBaseSchema.extend({ verdict: z.literal("unknown_issue") });

const replayVerdictUnionSchema = z.discriminatedUnion("verdict", [
    engineErrorVerdictSchema,
    applicationBugVerdictSchema,
    unknownIssueVerdictSchema,
]);

/**
 * A reviewer's replay verdict. The wire schema sent to the model is the flat
 * {@link replayVerdictBaseSchema} (Gemini-compatible); parsing pipes it into a
 * discriminated union on `verdict`, so the inferred type narrows per kind for
 * consumers and future slices can attach per-kind required fields.
 */
export const replayVerdictSchema = replayVerdictBaseSchema.pipe(replayVerdictUnionSchema);

export type ReplayVerdict = z.infer<typeof replayVerdictSchema>;
