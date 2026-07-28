import type { ScenarioRecipe } from "@autonoma/types";
import type { DryRunOptions } from "../routes/scenarios/scenarios.service";

/**
 * Build the dry-run options for an MCP call.
 *
 * `DryRunOptions` is a discriminated union: promoting a candidate requires saying who is promoting
 * it, so `save: true` only exists on the variant that carries a source. Both MCP servers have to
 * satisfy that, and both attribute to `MCP` - so the narrowing lives here once rather than being
 * re-derived (and re-checked) at each tool.
 *
 * `save` without a `recipe` is meaningless - there is nothing to promote - and collapses to a
 * plain run of the stored recipe.
 */
export function dryRunOptions(recipe: ScenarioRecipe | undefined, save: boolean, actorUserId?: string): DryRunOptions {
    if (recipe != null && save) {
        return { recipe, save: true, source: "MCP", actorUserId };
    }
    return { recipe };
}
