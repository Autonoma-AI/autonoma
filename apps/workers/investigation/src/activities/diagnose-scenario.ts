import { db } from "@autonoma/db";
import {
    type ScenarioDiagnosis,
    ScenarioRecipe,
    TestCatalog,
    diagnoseScenarioFailure,
    editRecipeCreateGraph,
    persistInvestigationCosts,
} from "@autonoma/investigation";
import { logger as rootLogger } from "@autonoma/logger";
import type { DiagnoseInvestigationScenarioInput, InvestigationScenarioDiagnosis } from "@autonoma/workflow/activities";
import type { LanguageModel } from "ai";
import { createModelSession } from "../services";

/**
 * Diagnose a single scenario failure into a repair route and compute the concrete candidate recipe. This is a
 * DRY-RUN for every org: it only reads + reasons, never writes. Loads the two things the diagnoser needs but the
 * workflow does not carry - the test's pinned plan and the scenario's recipe `create` graph - then runs the
 * classifier-backed router. The workflow decides whether to ACT on the result (activate the recipe / apply the
 * test fix), gated per org by autofix. Returns `undefined` when the test has no bound scenario (there is no
 * recipe to reason about), so the caller simply omits a diagnosis. Contained by the caller: any throw is logged
 * and dropped, never sinking the report.
 */
export async function diagnoseInvestigationScenario(
    input: DiagnoseInvestigationScenarioInput,
): Promise<InvestigationScenarioDiagnosis | undefined> {
    const { snapshotId, slug, failureDetail, runObservation } = input;
    const logger = rootLogger.child({ name: "diagnoseInvestigationScenario", extra: { snapshotId, slug } });
    logger.info("Diagnosing scenario failure");

    const catalog = new TestCatalog(db);
    const resolved = await catalog.resolveSnapshotPlan(snapshotId, slug);
    if (resolved?.scenarioId == null) {
        logger.info("No bound scenario for this test; skipping diagnosis");
        return undefined;
    }

    const recipeCreateGraph = await new ScenarioRecipe(db).getCreateGraph(resolved.scenarioId, snapshotId);
    if (recipeCreateGraph == null) {
        logger.info("No recipe version for this scenario/snapshot; skipping diagnosis");
        return undefined;
    }

    const testPlan = (await catalog.getSnapshotPlan(snapshotId, slug)) ?? "";
    const session = createModelSession();
    const model = session.getModel({ model: "classifier", tag: "investigation-diagnose" });

    const diagnosis = await diagnoseScenarioFailure(
        { testPlan, recipeCreateGraph, failureDetail, runObservation },
        { model },
    );
    logger.info("Scenario failure diagnosed", {
        extra: { route: diagnosis.route, confidence: diagnosis.confidence },
    });

    // Dry-run proposal: compute the exact recipe we WOULD activate, for every org. Nothing is written here -
    // the workflow only applies it when autofix is enabled. Contained: a failed edit just omits the proposal.
    const proposal = await proposeRecipeEdit({ diagnosis, recipeCreateGraph, failureDetail, testPlan, model, logger });

    await persistInvestigationCosts(db, snapshotId, session.costCollector, logger);

    return {
        route: diagnosis.route,
        confidence: diagnosis.confidence,
        reasoning: diagnosis.reasoning,
        testFix: diagnosis.testFix,
        recipeChange: diagnosis.recipeChange,
        factoryIssue: diagnosis.factoryIssue,
        proposedRecipeCreateGraph: proposal?.createGraphJson,
        proposedRecipeSummary: proposal?.summary,
    };
}

/**
 * When the route calls for a recipe change, produce the concrete candidate `create` graph (the exact recipe the
 * agent would activate). Returns undefined for routes that don't touch the recipe, when there's no recipe-change
 * instruction, or when the edit could not be produced - the caller then simply reports no proposed recipe.
 */
async function proposeRecipeEdit(params: {
    diagnosis: ScenarioDiagnosis;
    recipeCreateGraph: string;
    failureDetail: string;
    testPlan: string;
    model: LanguageModel;
    logger: ReturnType<typeof rootLogger.child>;
}): Promise<{ createGraphJson: string; summary: string } | undefined> {
    const { diagnosis, recipeCreateGraph, failureDetail, testPlan, model, logger } = params;
    const wantsRecipe = diagnosis.route === "recipe_only" || diagnosis.route === "recipe_and_sdk";
    if (!wantsRecipe || diagnosis.recipeChange == null || diagnosis.recipeChange === "") return undefined;

    try {
        const edit = await editRecipeCreateGraph(
            { currentCreateGraph: recipeCreateGraph, recipeChange: diagnosis.recipeChange, failureDetail, testPlan },
            { model },
        );
        return { createGraphJson: JSON.stringify(edit.createGraph), summary: edit.summary };
    } catch (error) {
        logger.warn("Recipe edit proposal failed; reporting the route without a candidate recipe", {
            extra: { error: String(error) },
        });
        return undefined;
    }
}
