import { z } from "zod";
import { Category, Confidence, EvidenceSource, PlanFidelity, type RunVerdict } from "../schema";

/**
 * The schema the MODEL produces. It mirrors RunVerdict but makes the optional fields NULLABLE-and-required
 * rather than optional, because OpenAI's strict structured-output mode requires every property to appear in
 * `required`. The result is normalized back to the public RunVerdict shape (null -> undefined).
 */
export const VerdictForModel = z.object({
    category: Category,
    isClientBug: z.boolean(),
    ran: z.boolean(),
    confidence: Confidence,
    planFidelity: PlanFidelity,
    headline: z.string(),
    falsePositiveRisk: z.string(),
    whatHappened: z.string(),
    rootCause: z.string(),
    remediation: z.string(),
    suggestedTestUpdate: z.string().nullable(),
    // App problems VISIBLE in the video that are independent of this test's pass/fail (broken images, empty
    // content where data is expected, layout/overlap issues, things not loading). Null when the app looked healthy.
    observedAppIssues: z.string().nullable(),
    // Distinct visible defects SEPARATE from this test's assertion, each promoted to its OWN finding (the trackable
    // breakdown of observedAppIssues). Empty array when nothing else was visibly broken - never null (strict mode).
    secondaryObservations: z.array(
        z.object({
            category: Category,
            confidence: Confidence,
            headline: z.string(),
            detail: z.string(),
        }),
    ),
    evidence: z
        .array(
            z.object({
                source: EvidenceSource,
                detail: z.string(),
                file: z.string().nullable(),
                lines: z.string().nullable(),
                snippet: z.string().nullable(),
            }),
        )
        .min(1),
    // The 1-indexed trace step whose screenshot most clearly shows this finding to a human (the frame to feature
    // in the report). NOT necessarily the failed step - pick the most descriptive image. Null -> use the final
    // screenshot.
    keyStepIndex: z.number().int().nullable(),
});
export type VerdictForModel = z.infer<typeof VerdictForModel>;

/** Normalize the model-output verdict (nullable fields) into the public RunVerdict shape (undefined for absent). */
export function toRunVerdict(modelVerdict: VerdictForModel): RunVerdict {
    return {
        category: modelVerdict.category,
        isClientBug: modelVerdict.isClientBug,
        ran: modelVerdict.ran,
        confidence: modelVerdict.confidence,
        planFidelity: modelVerdict.planFidelity,
        headline: modelVerdict.headline,
        falsePositiveRisk: modelVerdict.falsePositiveRisk,
        whatHappened: modelVerdict.whatHappened,
        rootCause: modelVerdict.rootCause,
        remediation: modelVerdict.remediation,
        suggestedTestUpdate: modelVerdict.suggestedTestUpdate ?? undefined,
        observedAppIssues: modelVerdict.observedAppIssues ?? undefined,
        secondaryObservations:
            modelVerdict.secondaryObservations.length > 0 ? modelVerdict.secondaryObservations : undefined,
        evidence: modelVerdict.evidence.map((item) => ({
            source: item.source,
            detail: item.detail,
            file: item.file ?? undefined,
            lines: item.lines ?? undefined,
            snippet: item.snippet ?? undefined,
        })),
        keyStepIndex: modelVerdict.keyStepIndex ?? undefined,
    };
}
