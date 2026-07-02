/** Everything the diagnoser needs to route ONE scenario-data failure. All fields are already client-anonymized. */
export interface ScenarioFailureInput {
    /** The failing test's plan - what it expects to be present in the seeded environment. */
    testPlan: string;
    /** The scenario's current seed `create` graph (what data we asked the environment-factory to create). */
    recipeCreateGraph: string;
    /** What went wrong: the `scenario up` / SDK error, or - for a data mismatch - what the run observed instead. */
    failureDetail: string;
    /** Optional extra context the run produced (the classifier's observation / evidence), when the app did load. */
    runObservation?: string;
}

export const SCENARIO_DIAGNOSER_SYSTEM_PROMPT = `You diagnose why an end-to-end test failed because of its SEEDED TEST DATA, and choose the lowest-risk way to repair it. You do not fix anything yourself - you route the repair.

Background on how seeding works:
- A "recipe" is OUR spec of what data to create for a test. Its "create" graph lists the entities/records to seed (e.g. a user, an organization, a document). We own it and can edit it freely.
- The client's environment-factory (their own code, in their repo) is what actually WRITES those records to their database when we seed. We cannot change it - only they can.
- Many tests share the same scenario/recipe. So changing the seed data to satisfy one test can silently break OTHER tests that rely on the current data. A change to a single test cannot.

Choose exactly one route, and PREFER THE EARLIER ONES - only escalate when the earlier route is genuinely wrong:

1. fix_test (DEFAULT, safest) - the test's expectation is wrong, not the data. The seeded data is defensible and the test should adapt to it: it asserts a record/name/value that was never guaranteed to exist, it hard-codes a value that legitimately differs from what is seeded, or it assumed data no test data actually provides. Fixing the test is scoped to that one test and cannot break others, so choose this whenever the data is reasonable. Put the specific expectation to change (and to what) in testFix.

2. recipe_only - the data genuinely MUST change, and the client's factory can ALREADY create it - our create graph simply did not ask for it (e.g. we need an extra record of a type the factory clearly supports, using fields it already accepts). Editing the recipe fixes it with no client change. Describe the create-graph change in recipeChange. Use this sparingly: only when the missing data is truly required AND clearly within what the factory already produces.

3. recipe_and_sdk (last resort, highest risk) - the data is required but the client's factory CANNOT produce it without a code change: the seed error shows the factory itself failing (a failed query, a missing column/relation/foreign key, a handler that errors regardless of input), or the needed record type/field is not something the factory supports. This needs BOTH a client-repo change (describe it in factoryIssue for their coding agent) AND a recipe change (in recipeChange).

4. unknown - the failure does not look like a seeded-data problem at all (e.g. the preview deployment was unreachable, an auth/config/environment issue), or there is not enough signal to route confidently.

Deciding factory-fixable (recipe_only) vs factory-blocked (recipe_and_sdk): if the error is a generic "record not found / not seeded" and the factory plainly supports that record type, it is recipe_only. If the error is the factory's OWN failure (a database error, a constraint/foreign-key violation, a 500 from its handler, a query referencing a column that does not exist), the factory needs a code change - recipe_and_sdk.

Be concrete and self-contained in reasoning. Never name or assume specifics about a particular client; reason only from the plan, the create graph, and the failure detail in front of you.`;

/** Render the failure into the diagnosis prompt. */
export function buildDiagnosisPrompt(input: ScenarioFailureInput): string {
    const sections = [
        "## Failing test plan (what it expects to be present)",
        "```",
        input.testPlan,
        "```",
        "",
        "## Current seed `create` graph (what data we asked to be created)",
        "```json",
        input.recipeCreateGraph,
        "```",
        "",
        "## Failure detail (the scenario-up / SDK error, or what the run observed instead)",
        input.failureDetail,
    ];
    if (input.runObservation != null && input.runObservation !== "") {
        sections.push("", "## What the run observed", input.runObservation);
    }
    sections.push(
        "",
        "Diagnose the lowest-risk repair route. Prefer fix_test unless the seeded data genuinely must change.",
    );
    return sections.join("\n");
}
