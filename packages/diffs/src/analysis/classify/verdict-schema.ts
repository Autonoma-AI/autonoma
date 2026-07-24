import { z } from "zod";
import { Category, Confidence, EvidenceSource, PlanFidelity, RunVerdict } from "../schema";

/**
 * The flat schema the MODEL fills. Every field is present (OpenAI's strict structured-output mode requires each
 * property in `required`), with per-category-optional fields made NULLABLE rather than optional. It is piped into
 * the {@link RunVerdict} discriminated union by {@link toRunVerdict}: the model sees a plain object, while
 * consumers get per-category narrowing and the union enforces which fields a given category must carry (e.g. a
 * `client_bug` must have expected/actual/falsePositiveRisk; a `passed` never carries falsePositiveRisk).
 */
export const VerdictForModel = z.object({
    category: Category,
    isClientBug: z.boolean(),
    ran: z.boolean(),
    confidence: Confidence,
    planFidelity: PlanFidelity,
    headline: z.string(),
    // What the app SHOULD have done / what it actually did. Null only for engine_artifact (no app behavior to
    // describe); every other category fills both, including a passed run (the behavior it confirmed correct).
    expectedBehavior: z.string().nullable(),
    actualBehavior: z.string().nullable(),
    // The false-positive self-check. Set for a bug / setup failure; null for passed / engine_artifact / a wrong test.
    falsePositiveRisk: z.string().nullable(),
    // The COMPLETE revised test plan for a bad_test / outdated_test (or a fidelity tightening); null otherwise.
    suggestedTestUpdate: z.string().nullable(),
    // App problems VISIBLE in the video that are independent of this test's pass/fail (broken images, empty
    // content where data is expected, layout/overlap issues, things not loading). Null when the app looked healthy.
    observedAppIssues: z.string().nullable(),
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

/**
 * Normalize the flat model output (nullable fields -> undefined) and validate it into the discriminated
 * {@link RunVerdict}. The union parse drops the fields that don't apply to the chosen category and enforces the
 * ones that do, so a malformed verdict (e.g. a `client_bug` with no `expectedBehavior`) fails loudly here - the
 * Investigator contains that as an engine artifact rather than persisting a half-filled finding.
 */
export function toRunVerdict(modelVerdict: VerdictForModel): RunVerdict {
    return RunVerdict.parse({
        category: modelVerdict.category,
        isClientBug: modelVerdict.isClientBug,
        ran: modelVerdict.ran,
        confidence: modelVerdict.confidence,
        planFidelity: modelVerdict.planFidelity,
        headline: modelVerdict.headline,
        expectedBehavior: modelVerdict.expectedBehavior ?? undefined,
        actualBehavior: modelVerdict.actualBehavior ?? undefined,
        falsePositiveRisk: modelVerdict.falsePositiveRisk ?? undefined,
        suggestedTestUpdate: modelVerdict.suggestedTestUpdate ?? undefined,
        observedAppIssues: modelVerdict.observedAppIssues ?? undefined,
        evidence: modelVerdict.evidence.map((item) => ({
            source: item.source,
            detail: item.detail,
            file: item.file ?? undefined,
            lines: item.lines ?? undefined,
            snippet: item.snippet ?? undefined,
        })),
        keyStepIndex: modelVerdict.keyStepIndex ?? undefined,
    });
}
