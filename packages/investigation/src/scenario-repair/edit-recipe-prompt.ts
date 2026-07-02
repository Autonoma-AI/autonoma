/** The inputs the recipe editor needs to turn a `recipe_only`/`recipe_and_sdk` diagnosis into a concrete edit. */
export interface RecipeEditInput {
    /** The scenario recipe's current `create` graph (the seed request), as a JSON string. */
    currentCreateGraph: string;
    /** The change the diagnoser said the recipe needs (prose - e.g. "seed an Annual Facility Upkeep project"). */
    recipeChange: string;
    /** The failure being repaired, for context (the SDK error or the run's data-mismatch account). */
    failureDetail: string;
    /** The test plan the edited recipe must satisfy, if available. */
    testPlan?: string;
}

/**
 * The recipe editor turns a diagnosed recipe change into a concrete new `create` graph. It edits OUR seed
 * request (which entities/records to create, with their fields and refs) - NOT the client's factory code. The
 * edit must be MINIMAL and preserve everything else verbatim so a re-seed changes only what the failure needs.
 */
export const RECIPE_EDITOR_SYSTEM_PROMPT = `You edit an Autonoma scenario recipe's "create" graph - the seed request that tells the client's environment-factory which records to create for a test. You are given the current create graph, a described change it needs, and the failure being fixed. Produce the COMPLETE new create graph.

The create graph is a JSON object keyed by model name; each value is an array of record objects. A record may use:
- "_alias": a local handle so other records can reference this one.
- "_ref": { "_ref": "someAlias" } - a reference to another seeded record by its alias.
- template variables like "{{testRunId}}" or "{{student_email}}" - leave these EXACTLY as they are.

Rules:
- Make the SMALLEST change that satisfies the described recipe change. Preserve every other record, field, alias, ref, template variable, key order, and value verbatim.
- Only add or adjust records of a model that ALREADY appears in the graph, or that is clearly the same kind the factory already produces. Do not invent new model types the factory may not support.
- When you add a record, mirror the shape of the existing records of that model (same field names, same ref style). Fill only the fields the test needs; let the factory default the rest.
- Never remove data another test might rely on unless the change explicitly requires it.
- Keep the output STRICT, valid JSON. Do not include comments or trailing commas.

Return:
- createGraphJson: the complete new create graph as a JSON string (the whole object, not a diff).
- summary: one sentence describing exactly what you changed.`;

/** Build the user prompt: the current graph, the change to make, and the failure + plan for grounding. */
export function buildRecipeEditPrompt(input: RecipeEditInput): string {
    const sections = [
        "## Current create graph",
        "```json",
        input.currentCreateGraph,
        "```",
        "",
        "## Change the recipe needs",
        input.recipeChange,
        "",
        "## Failure being fixed",
        input.failureDetail,
    ];
    if (input.testPlan != null && input.testPlan !== "") {
        sections.push("", "## Test plan the edited recipe must satisfy", input.testPlan);
    }
    sections.push("", "Produce the complete new create graph and a one-sentence summary of the change.");
    return sections.join("\n");
}
