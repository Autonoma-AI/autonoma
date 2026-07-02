import type { RepairRecipeInput } from "./repair-recipe-deps";

/**
 * The recipe-repair agent's system prompt. Unlike the one-shot editor, this agent has TOOLS: it reads the client's
 * factory/seeding code and DB schema, greps the repo, queries the LIVE backend to see what data actually exists,
 * validates a candidate graph locally, and dry-run-seeds it against the real factory before committing. Its job is
 * to determine what data the test truly needs and produce a create graph the factory will actually accept - or,
 * when it can't, to route honestly (the test is wrong; or the factory itself needs a code change) with evidence.
 */
export const REPAIR_RECIPE_AGENT_SYSTEM_PROMPT = `You repair an Autonoma scenario recipe's "create" graph - the seed request that tells the client's environment-factory which records to create for a test - for a test that failed on its seeded data. You have tools to investigate the client's code and live environment; USE them before proposing anything.

The create graph is a JSON object keyed by model name; each value is an array of record objects. A record may use "_alias" (a local handle), "_ref": { "_ref": "someAlias" } (a reference to another seeded record), and template variables like "{{testRunId}}" or "{{admin_email}}" (leave these EXACTLY as they are).

Your tools:
- read_code / grep_code: the CLIENT's repo at the PR head - read the environment-factory / seeding handler to see exactly which models and fields it CAN create, and the DB schema (prisma/schema.prisma, migrations) to understand the data model and relations.
- git_diff: the PR's patch, to see what the PR changed.
- run_script: run a read-only Node script against the LIVE preview backend (install the client's DB SDK, e.g. 'pg' or 'firebase-admin', and query) - to CONFIRM whether the data the test needs already exists.
- get_preview_env: which env vars the preview has (a missing integration key means that feature falls back to its default).
- validate_recipe_schema: validate a candidate graph's structure + that every _ref resolves. Call on EVERY candidate.
- dry_run_seed (may be unavailable): seed a candidate against the real factory and tear it down - the authoritative check that the factory accepts it. Use once you have a schema-valid candidate.

How to decide the route (prefer the lowest blast radius):
1. FIRST verify the needed data is not ALREADY seeded. Inspect the current create graph AND query the live backend with run_script. If the record the test wants already exists (just under a different path/name than the test looks for), the recipe is fine - the TEST is wrong. Route "fix_test" and explain what the test should do instead. Do NOT propose redundant data.
2. If the data genuinely must change AND the factory can already create it (read the seeding code to confirm the model+fields are supported), route "recipe_only". Produce the COMPLETE minimal edited graph - preserve every other record, field, alias, ref, template var, and key order verbatim; add only what the test needs, mirroring the shape of existing records of that model. Then validate_recipe_schema, then dry_run_seed. If the seed fails, read the factory's error and revise; iterate.
3. If the factory CANNOT produce the needed data without a code change (dry_run_seed fails because a model/field/handler is missing, or the seeding code plainly has no path for it), route "recipe_and_sdk": describe the exact client-factory change in factoryIssue (for their coding agent) AND give the recipe change that would work once they make it, and set handoff to a self-contained summary of what you tried, what the factory rejected, and what they must change.
4. If you cannot get a viable, factory-accepted recipe after iterating, set handoff to your best candidate + each thing you tried and why it failed, so a human or coding agent can take it from there. Never emit a recipe you could not validate.

Rules for any graph you emit: STRICT valid JSON, no comments/trailing commas; the COMPLETE new graph (not a diff); minimal change; never remove data another test may rely on.`;

/** Build the user prompt: the failing test, the diagnosis's recipe-change hint, the current graph, and the failure. */
export function buildRepairRecipePrompt(input: RepairRecipeInput): string {
    return [
        `Repair the scenario recipe for a failing test.`,
        `App: ${input.appSlug}  PR #${input.prNumber}  Test: ${input.slug}`,
        "",
        "## What the diagnosis said the recipe needs (a hint - verify it before trusting it)",
        input.recipeChange !== "" ? input.recipeChange : "(no specific change described)",
        "",
        "## The failure being repaired",
        input.failureDetail,
        "",
        "## Test plan the repaired recipe must satisfy",
        input.testPlan !== "" ? input.testPlan : "(plan unavailable)",
        "",
        "## Current create graph (the seed request as it stands)",
        "```json",
        input.currentCreateGraph,
        "```",
        ...renderPriorAttempts(input),
        "",
        "Investigate with the tools, then decide the route and (for a recipe route) produce the complete validated create graph.",
    ].join("\n");
}

/**
 * Render the earlier passes that seeded but still failed the REAL test. This is the outer loop's whole point: each
 * of these graphs was accepted by the factory, so the problem is NOT that the data failed to seed - it is that the
 * data was WRONG (wrong values, wrong shape, missing a relation the test reads). The agent must diagnose why each
 * failed from its run account and produce a materially different graph, not re-add the same records.
 */
function renderPriorAttempts(input: RepairRecipeInput): string[] {
    const attempts = input.priorAttempts ?? [];
    if (attempts.length === 0) return [];

    const lines = [
        "",
        "## Recipes you ALREADY tried that seeded but the test STILL failed (do NOT repeat them)",
        "Each graph below was accepted by the factory, so seeding is not the problem - the DATA was wrong. Read how",
        "the test failed with each, then produce a materially different graph that addresses it.",
    ];
    attempts.forEach((attempt, index) => {
        lines.push(
            "",
            `### Attempt ${index + 1}`,
            "```json",
            attempt.createGraphJson,
            "```",
            `Then the test failed with: ${attempt.failureDetail}`,
        );
    });
    return lines;
}
