import { z } from "zod";

/**
 * How to repair a test that failed because of its seeded scenario data, ordered by blast radius (safest first):
 * - `fix_test`: the test's expectation was wrong (e.g. it asserts a record that was never supposed to exist, or
 *   a value that legitimately differs from what is seeded). Change the TEST - it is scoped to one test and
 *   cannot break others. This is the DEFAULT and should be preferred whenever the seeded data is defensible.
 * - `recipe_only`: the data genuinely needs to change AND the client's environment-factory can already produce
 *   it - our `create` graph simply did not ask for it. Editing the recipe fixes it with no client change.
 * - `recipe_and_sdk`: the data is required but the client's factory cannot produce it without a code change
 *   (a missing relation/column/handler). Needs a client-repo change (a PR comment for their coding agent) AND a
 *   recipe change - so it is the highest-risk, last-resort route.
 * - `unknown`: not enough signal to route confidently (e.g. the failure looks like an environment problem, not
 *   the seeded data at all).
 */
export type ScenarioRepairRoute = "fix_test" | "recipe_only" | "recipe_and_sdk" | "unknown";

/** The diagnosis for one scenario-data failure: which repair route, why, and a concise description per route. */
export interface ScenarioDiagnosis {
    route: ScenarioRepairRoute;
    confidence: "low" | "medium" | "high";
    /** Self-contained explanation of the diagnosis, so a report reads without cross-referencing. */
    reasoning: string;
    /** `fix_test`: what to change in the test (which assertion/expectation and to what). Absent otherwise. */
    testFix?: string;
    /** `recipe_only` / `recipe_and_sdk`: the change the seed `create` graph needs. Absent otherwise. */
    recipeChange?: string;
    /** `recipe_and_sdk`: the client-factory limitation to describe in the PR comment for their agent. Absent otherwise. */
    factoryIssue?: string;
}

/**
 * The schema the MODEL produces. Every optional field is NULLABLE-and-required rather than `.optional()` because
 * OpenAI's strict structured-output mode rejects a property that is not listed in `required`. `toScenarioDiagnosis`
 * normalizes the nulls back to `undefined` and drops fields that do not belong to the chosen route.
 */
export const ScenarioDiagnosisForModel = z.object({
    route: z.enum(["fix_test", "recipe_only", "recipe_and_sdk", "unknown"]),
    confidence: z.enum(["low", "medium", "high"]),
    reasoning: z.string(),
    testFix: z.string().nullable(),
    recipeChange: z.string().nullable(),
    factoryIssue: z.string().nullable(),
});

/** Normalize the model output into the public shape: null -> undefined, and clear fields off-route. */
export function toScenarioDiagnosis(output: z.infer<typeof ScenarioDiagnosisForModel>): ScenarioDiagnosis {
    const wantsRecipe = output.route === "recipe_only" || output.route === "recipe_and_sdk";
    const testFix = output.route === "fix_test" ? (output.testFix ?? undefined) : undefined;
    const recipeChange = wantsRecipe ? (output.recipeChange ?? undefined) : undefined;
    const factoryIssue = output.route === "recipe_and_sdk" ? (output.factoryIssue ?? undefined) : undefined;

    // A route whose required actionable field is missing gives the caller nothing to act on (e.g. a
    // recipe_and_sdk with no factoryIssue would yield an empty PR-comment payload). Downgrade to `unknown` so the
    // workflow only ever acts on a route that carries its concrete instruction.
    if (missingActionableDetail(output.route, { testFix, recipeChange, factoryIssue })) {
        return {
            route: "unknown",
            confidence: output.confidence,
            reasoning: `${output.reasoning} (downgraded from ${output.route}: missing the route's required detail)`,
        };
    }

    return {
        route: output.route,
        confidence: output.confidence,
        reasoning: output.reasoning,
        testFix,
        recipeChange,
        factoryIssue,
    };
}

/** Whether a diagnosed route is missing the field(s) that make it actionable. `unknown` never needs any. */
function missingActionableDetail(
    route: ScenarioRepairRoute,
    fields: { testFix?: string; recipeChange?: string; factoryIssue?: string },
): boolean {
    if (route === "fix_test") return fields.testFix == null;
    if (route === "recipe_only") return fields.recipeChange == null;
    if (route === "recipe_and_sdk") return fields.recipeChange == null || fields.factoryIssue == null;
    return false;
}
