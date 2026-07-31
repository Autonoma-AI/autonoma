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
    // What the app SHOULD have done / what it actually did - the app-health plane's behavior claim. Filled by
    // `passed` and `client_bug`; null for every coverage verdict (engine_artifact / environment_failure /
    // scenario_issue / plan_mismatch / invalid_test), which describe a non-app cause instead.
    expectedBehavior: z.string().nullable(),
    actualBehavior: z.string().nullable(),
    // Free-form account of what happened - the coverage plane's analog of expected/actual. Filled by the coverage
    // faults (engine_artifact / environment_failure / scenario_issue); null for the app-health verdicts, plan_mismatch
    // and invalid_test (which carry their own dedicated notes instead).
    whatHappened: z.string().nullable(),
    // The false-positive self-check. Set for client_bug / environment_failure / scenario_issue / invalid_test; null
    // for passed / engine_artifact / plan_mismatch.
    falsePositiveRisk: z.string().nullable(),
    // The COMPLETE revised test plan for a plan_mismatch (the plan the self-heal loop re-runs); null otherwise.
    suggestedTestUpdate: z.string().nullable(),
    // The plan_mismatch self-heal post-mortem: what the test asserted that was wrong, the rewrite attempted, and why
    // it still failed; null for every other category.
    planMismatchNote: z.string().nullable(),
    // The invalid_test justification (null for every other category): name the failure mode - a NONEXISTENT feature
    // (no component / i18n key / git history), STRUCTURALLY UNEXECUTABLE steps (a plan step no browser test can drive,
    // e.g. "run this SQL"), a PREMISE that CONTRADICTS the app, or an otherwise UNRECOVERABLE test - and PROVE it (the
    // evidence array must back the claim). This verdict REMOVES the test, so the bar is impossibility, not "wrong":
    // default to plan_mismatch (keep) whenever you are unsure.
    invalidTestNote: z.string().nullable(),
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
    // The step NUMBER as the trace renders it (`N. +M:SS [interaction] ...`) whose frame most clearly shows this
    // finding to a human - NOT a position in the list, since `resolveKeyScreenshot` matches it against the
    // attempt's own `order`. Not necessarily the failed step: pick the most descriptive image. Null means NO
    // screenshot is shown; there is deliberately no fallback to the final frame, which is often a blank or setup
    // screen that reads as a misleading "failure". This comment is for the next reader - the wording the MODEL
    // sees lives in the prompt, since this schema declares no `.describe()`.
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
        whatHappened: modelVerdict.whatHappened ?? undefined,
        falsePositiveRisk: modelVerdict.falsePositiveRisk ?? undefined,
        suggestedTestUpdate: modelVerdict.suggestedTestUpdate ?? undefined,
        planMismatchNote: modelVerdict.planMismatchNote ?? undefined,
        invalidTestNote: modelVerdict.invalidTestNote ?? undefined,
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
