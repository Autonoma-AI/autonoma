import { z } from "zod";
import { failurePointSchema, reviewEvidenceSchema } from "./generation-verdict";

export const replayVerdictKindSchema = z.enum(["engine_error", "application_bug"]);
export type ReplayVerdictKind = z.infer<typeof replayVerdictKindSchema>;

export const replayVerdictSchema = z.object({
    verdict: replayVerdictKindSchema.describe(
        "Root cause of the replay failure. 'engine_error' means the recorded steps no longer match the application UI; 'application_bug' means the steps are correct but the app misbehaved.",
    ),
    title: z.string().describe("Short, bug-report-style title (under 100 chars)"),
    reasoning: z.string().describe("Detailed explanation of the verdict"),
    failurePoint: failurePointSchema.describe("Where the failure occurred"),
    evidence: z.array(reviewEvidenceSchema).describe("Supporting evidence from the analysis"),
});

export type ReplayVerdict = z.infer<typeof replayVerdictSchema>;
