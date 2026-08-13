import { analysisRunTargetSchema } from "@autonoma/types";
import { z } from "zod";
import {
    type ReporterInput,
    type ReporterScenarioRecipe,
    reporterBranchTestSchema,
    reporterExistingIssueSchema,
    reporterFindingSchema,
    reporterPriorReportSchema,
    reporterScenarioRecipeSchema,
    reporterScenarioSummarySchema,
} from "./types";

/**
 * The frozen, on-disk projection of a {@link ReporterInput}, minus its live-only fields: the cloned `codebase`
 * (rehydrated from git coords by the eval) and the two loaders (`screenshotLoader`, `scenarioLoader`), whose data
 * is frozen instead. Screenshots keep their `s3Key`, rehydrated to bytes at run time; the scenario loader's whole
 * resolved output is frozen into `scenarioRecipes`, so `read_scenario` replays as a pure lookup with no DB.
 *
 * It COMPOSES the DTO schemas from `./types` (which infer the runtime interfaces) rather than re-declaring them, so
 * a field added to a nested DTO flows into both the type and this frozen schema from one edit - it cannot silently
 * drift out of a captured case. The only payload-specific top-level shape is `range`, `appSlug` and the
 * `scenarioRecipes` array that stands in for the live `scenarioLoader`.
 *
 * Written by production at report birth and read back by capture, so a case is exactly what the Reporter saw -
 * never a reconstruction. Reconstructing the branch's mutable issues would leak the run's own answer (a carried-
 * forward issue is overwritten in place) into its input, and grade the agent on reproducing it.
 *
 * The git coords are NOT frozen here: they are immutable facts a capture re-resolves from the snapshot, so this
 * payload carries only the mutable, un-reconstructable content. The eval's case schema extends this with coords.
 */
export const reporterInputPayloadSchema = z.object({
    appSlug: z.string(),
    target: analysisRunTargetSchema,
    range: z.object({ baseSha: z.string(), headSha: z.string() }),
    impactReasoning: z.string().optional(),
    findings: z.array(reporterFindingSchema),
    branchTests: z.array(reporterBranchTestSchema),
    existingIssues: z.array(reporterExistingIssueSchema),
    priorReports: z.array(reporterPriorReportSchema),
    scenarioIndex: z.array(reporterScenarioSummarySchema),
    scenarioRecipes: z.array(reporterScenarioRecipeSchema),
});

export type ReporterInputPayload = z.infer<typeof reporterInputPayloadSchema>;

/**
 * The S3 key the Reporter's frozen input is uploaded to, under the snapshot's `diffs-job/<snapshotId>/` artifact
 * prefix (shared with the conversation upload). One source of truth so the runtime upload and the eval capture
 * that reads it back can never disagree on where the payload lives.
 */
export function reporterInputStorageKey(snapshotId: string): string {
    return `diffs-job/${snapshotId}/reporter-input.json`;
}

/**
 * The {@link ReporterInput} fields with no frozen form: the on-disk clone and the two loaders. Everything else
 * must be serialized. A field added to `ReporterInput` that is genuinely live-only is added here; anything else
 * belongs in {@link reporterInputPayloadSchema}.
 */
type LiveOnlyReporterInputField = "codebase" | "screenshotLoader" | "scenarioLoader";

/** Any `ReporterInput` field that is neither frozen in the payload nor declared live-only. Must be `never`. */
type UnfrozenReporterInputField = Exclude<keyof ReporterInput, LiveOnlyReporterInputField | keyof ReporterInputPayload>;

/**
 * Compile-time coverage guard for the TOP-LEVEL `ReporterInput` fields. Empty while every serializable top-level
 * field is frozen; otherwise it gains a required element, so every `serializeReporterInput(input)` call below fails
 * to compile until the new field is either frozen in {@link reporterInputPayloadSchema} or declared in
 * {@link LiveOnlyReporterInputField}. NESTED drift needs no guard: the payload composes the same DTO schemas the
 * interfaces are inferred from, so a new field on `ReporterFinding` (say) flows into both at once.
 * `reporter-case-roundtrip.test.ts` covers the serialize/rehydrate behavior on top of that.
 */
type RequireEveryFieldFrozen = [UnfrozenReporterInputField] extends [never]
    ? []
    : [unfrozenReporterInputField: UnfrozenReporterInputField];

/**
 * Freeze an assembled {@link ReporterInput} into its on-disk payload: drop the live clone and the two loaders,
 * keep every screenshot's `s3Key`, and resolve the scenario loader's whole output into `scenarioRecipes` so
 * `read_scenario` replays as a pure lookup. Validated through the schema so a malformed payload can never be
 * uploaded. See {@link RequireEveryFieldFrozen} for the trailing coverage-guard parameter.
 */
export async function serializeReporterInput(
    input: ReporterInput,
    ..._requireEveryFieldFrozen: RequireEveryFieldFrozen
): Promise<ReporterInputPayload> {
    const scenarioRecipes: ReporterScenarioRecipe[] = [];
    if (input.scenarioLoader != null) {
        for (const summary of input.scenarioIndex) {
            const recipe = await input.scenarioLoader.loadRecipe(summary.id);
            if (recipe != null) scenarioRecipes.push(recipe);
        }
    }

    return reporterInputPayloadSchema.parse({
        appSlug: input.appSlug,
        target: input.target,
        range: input.range,
        impactReasoning: input.impactReasoning,
        findings: input.findings,
        branchTests: input.branchTests,
        existingIssues: input.existingIssues,
        priorReports: input.priorReports,
        scenarioIndex: input.scenarioIndex,
        scenarioRecipes,
    });
}
