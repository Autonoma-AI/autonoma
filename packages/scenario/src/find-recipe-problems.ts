import { logger as rootLogger } from "@autonoma/logger";
import { findRecipeCreateGraphProblems, type ScenarioRecipe } from "@autonoma/types";
import { resolveRecipePayload } from "@autonoma/types/scenario-recipe-resolver";

/**
 * Stand-in run id for the resolution rehearsal. Its only job is to make token
 * substitution runnable without provisioning anything - the resolved values are
 * thrown away, so the id itself never reaches a customer.
 */
const SAMPLE_TEST_RUN_ID = "00000000-0000-4000-8000-000000000000";

/**
 * Everything about a WHOLE recipe that will fail at provisioning time but is
 * knowable now, without a deploy or an SDK call.
 *
 * Two layers. The create graph goes through `findRecipeCreateGraphProblems` - the
 * same definition the planner CLI and the investigation repair agent use, so a
 * recipe cannot pass one gate and fail another. Then, only if the graph is sound,
 * the recipe is resolved against a stand-in run id, which is what catches the
 * problems that live in a `variables` block rather than in the graph (an unused
 * definition, an unsupported faker generator, a malformed derived format).
 *
 * Returns one human-readable message per problem (empty array = clean) so a caller
 * can hand the list straight back to whoever submitted the recipe - a UI editor,
 * an onboarding agent, the planner - and have them fix it. This is the check that
 * turns "the dry run failed twenty minutes later" into "the save was rejected with
 * the reason".
 */
export function findRecipeProblems(recipe: ScenarioRecipe): string[] {
    const logger = rootLogger.child({ name: "findRecipeProblems" });
    logger.info("Checking recipe for provisioning-time problems", { extra: { scenarioName: recipe.name } });

    const problems = findRecipeCreateGraphProblems(recipe.create, new Set(Object.keys(recipe.variables ?? {})));
    if (problems.length === 0) {
        try {
            resolveRecipePayload(recipe, SAMPLE_TEST_RUN_ID);
        } catch (err) {
            problems.push(err instanceof Error ? err.message : String(err));
        }
    }

    logger.info("Recipe check complete", { extra: { scenarioName: recipe.name, problemCount: problems.length } });
    return problems;
}
