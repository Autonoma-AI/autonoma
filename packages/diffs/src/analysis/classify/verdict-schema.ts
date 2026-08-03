import { declinable } from "@autonoma/ai";
import { z } from "zod";
import { Category, Confidence, EvidenceSource, PlanFidelity } from "../schema";

/**
 * The flat schema the MODEL fills, parsed into the `RunVerdict` discriminated union at the terminal tool. The
 * model sees a plain object with every field present ({@link declinable} is how it declines the ones its category
 * does not carry); the union is what enforces which fields each category requires. The wording the model reads
 * lives in the prompt - this schema declares no `.describe()`.
 */
export const VerdictForModel = z.object({
    category: Category,
    isClientBug: z.boolean(),
    ran: z.boolean(),
    confidence: Confidence,
    planFidelity: PlanFidelity,
    headline: z.string().min(1),
    expectedBehavior: declinable(z.string().min(1)),
    actualBehavior: declinable(z.string().min(1)),
    whatHappened: declinable(z.string().min(1)),
    falsePositiveRisk: declinable(z.string().min(1)),
    suggestedTestUpdate: declinable(z.string().min(1)),
    planMismatchNote: declinable(z.string().min(1)),
    invalidTestNote: declinable(z.string().min(1)),
    observedAppIssues: declinable(z.string().min(1)),
    evidence: z
        .array(
            z.object({
                source: EvidenceSource,
                detail: z.string().min(1),
                file: declinable(z.string().min(1)),
                lines: declinable(z.string().min(1)),
                snippet: declinable(z.string().min(1)),
            }),
        )
        .min(1),
    keyStepIndex: declinable(z.number().int()),
});
export type VerdictForModel = z.infer<typeof VerdictForModel>;
