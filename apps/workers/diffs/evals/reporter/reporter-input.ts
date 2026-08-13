import type { Codebase } from "@autonoma/diffs";
import { StorageEvidenceLoader } from "@autonoma/diffs";
import { type ReporterInput, type ReporterScenarioLoader, reporterInputPayloadSchema } from "@autonoma/diffs/analysis";
import type { StorageProvider } from "@autonoma/storage";
import type { z } from "zod";
import { codebaseCoordsSchema } from "../framework";

/**
 * The frozen, on-disk shape of a captured Reporter case (`input.json`): the runtime-serialized
 * `ReporterInputPayload` extended with the git coords the eval rehydrates the clone from.
 *
 * The payload half is the SAME schema production serializes ({@link reporterInputPayloadSchema}), so a case can
 * never diverge from what the Reporter actually saw - the whole reason capture reads the input back rather than
 * reconstructing it. The coords are the one part not in the runtime blob: they are immutable snapshot facts a
 * capture re-resolves from the DB.
 */
export const reporterCaseInputSchema = reporterInputPayloadSchema.extend({
    codebase: codebaseCoordsSchema,
});

export type ReporterCaseInput = z.infer<typeof reporterCaseInputSchema>;

/**
 * Rebuild the live {@link ReporterInput} from a parsed case: the clone (rehydrated separately via
 * `ensureCachedCheckout` and passed in) plus the two loaders reconstructed over the frozen data. The screenshot
 * loader fetches bytes from S3 by the frozen keys at run time; the scenario loader replays `read_scenario` as a
 * pure lookup over the frozen recipes - no DB, and no re-run of the production summarize step that could drift.
 */
export function rehydrateReporterInput(
    parsed: ReporterCaseInput,
    codebase: Codebase,
    storage: StorageProvider,
): ReporterInput {
    const recipesById = new Map(parsed.scenarioRecipes.map((recipe) => [recipe.id, recipe]));
    const scenarioLoader: ReporterScenarioLoader = {
        loadRecipe: async (scenarioId) => recipesById.get(scenarioId),
    };

    return {
        appSlug: parsed.appSlug,
        target: parsed.target,
        range: parsed.range,
        impactReasoning: parsed.impactReasoning,
        findings: parsed.findings,
        branchTests: parsed.branchTests,
        existingIssues: parsed.existingIssues,
        priorReports: parsed.priorReports,
        scenarioIndex: parsed.scenarioIndex,
        codebase,
        screenshotLoader: new StorageEvidenceLoader(storage),
        // Only advertise the scenario loader when there are scenarios to load, matching production: the agent is
        // never offered a dead `read_scenario` tool.
        scenarioLoader: parsed.scenarioIndex.length > 0 ? scenarioLoader : undefined,
    };
}
