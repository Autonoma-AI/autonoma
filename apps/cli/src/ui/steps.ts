import type { StepName } from "../core/state";

// Re-exported so UI modules keep one import site for step metadata.
export { STEP_ORDER } from "../core/state";

const MIN = 60_000;

/** Short, skimmable labels for the pipeline column. */
export const UI_STEP_LABELS: Record<StepName, string> = {
    projectMapper: "Map project",
    pagesFinder: "Map pages",
    kb: "Build knowledge base",
    entityAudit: "Model data",
    scenarioRecipe: "Design scenarios",
    recipeBuilder: "Set up test data",
    testGenerator: "Write E2E tests",
};

/** Dim one-liner under each step label - the "why this step exists". */
export const UI_STEP_WHY: Record<StepName, string> = {
    projectMapper: "find the frontend + backend",
    pagesFinder: "find every route",
    kb: "learn the app",
    entityAudit: "what the app stores",
    scenarioRecipe: "realistic data",
    recipeBuilder: "your coding agent wires the SDK",
    testGenerator: "page-by-page",
};

/**
 * One-line plain-language summary per step, used in the upfront overview, the
 * "continue?" prompts, and the help modal.
 */
export const STEP_SUMMARIES: Record<StepName, string> = {
    projectMapper: "Identify your frontend(s), backend(s), and which folders to ignore.",
    pagesFinder: "Map every page and route in your app.",
    kb: "Learn your app's features, flows, and UI patterns.",
    entityAudit: "Find what your app stores (users, orgs, ...) and how each one is created.",
    scenarioRecipe: "Decide the realistic data each test will run against.",
    recipeBuilder: "Wire up small helpers that create and clean up that data in your database.",
    testGenerator: "Write the end-to-end tests, covering every page and feature.",
};

/** The longer "what is happening and why" intro per step. */
export const STEP_INTROS: Record<StepName, string> = {
    projectMapper:
        "Looking at how your codebase is laid out - which folder(s) are the frontend, which are the backend/data layer, and which are unrelated - so every later step scans only what matters instead of the whole repo.",
    pagesFinder:
        "Scanning your codebase to find every page and route, so we know the full surface area that needs test coverage.",
    kb: "Reading those pages to learn your app's features, flows, and UI patterns - the context everything after this builds on.",
    entityAudit:
        "Finding the things your app stores (users, organizations, orders, ...) and how each one gets created, so we can generate realistic test data for them.",
    scenarioRecipe:
        "Designing the data each test will run against - concrete, realistic values that match how your app actually uses them.",
    recipeBuilder:
        "Handing off to your local coding agent to wire up small helpers that create and clean up test data in your own database. It implements them, generates the recipe, and validates each one live against your app running locally - you watch it work, then we continue.",
    testGenerator:
        "Writing the actual end-to-end tests, covering every page and feature with depth proportional to its complexity.",
};

/** What each step leaves behind - shown in the hero while it runs. */
export const STEP_OUTPUTS: Record<StepName, string> = {
    projectMapper: "project-map.json - which folders are the frontend and backend",
    pagesFinder: "pages.json - every route in your app",
    kb: "AUTONOMA.md - what your app does, feature by feature",
    entityAudit: "entity-audit.md - what your app stores and how it's created",
    scenarioRecipe: "scenarios.md - the realistic data your tests will run against",
    recipeBuilder: "recipe.json - validated test-data factories wired into your app",
    testGenerator: "qa-tests/ - one natural-language test per flow",
};

/**
 * Docs pages explaining what a step is doing, shown while it runs. Only steps
 * with a real, dedicated page get one - never link to a generic index.
 */
export const STEP_DOCS: Partial<Record<StepName, string>> = {
    recipeBuilder: "https://docs.autonoma.app/environment-factory/",
    testGenerator: "https://docs.autonoma.app/test-planner/",
};

/**
 * ETA budgets per step (ms). Most are flat; the recipe builder hands off to the
 * user's own coding agent so it is user-paced and carries a max bound.
 */
// Budgets come from measured medians in PostHog (cli_step_completed,
// status=done, 90 days to 2026-07-21; ~40-140 completions per step), rounded
// up toward p60 since the distributions are heavily right-skewed with repo
// size. recipeBuilder keeps a wide user-paced budget: the historical data
// predates the coding-agent handoff.
export const STEP_BUDGET: Record<StepName, { ms: number; maxMs?: number }> = {
    projectMapper: { ms: 3 * MIN },
    pagesFinder: { ms: 3 * MIN },
    kb: { ms: 12 * MIN },
    entityAudit: { ms: 10 * MIN },
    scenarioRecipe: { ms: 3 * MIN },
    recipeBuilder: { ms: 45 * MIN, maxMs: 120 * MIN },
    testGenerator: { ms: 30 * MIN, maxMs: 60 * MIN },
};

/**
 * Per-page budget rates for the steps whose duration scales with the page
 * count, which is known once the pages step completes. Only pages qualify as
 * a predictor today: the other size signals (entities, tests) are produced BY
 * their own steps, so they can't size those budgets ahead of time - the live
 * in-run rate (eta.ts) covers them instead.
 *
 * Measured from cli_step_completed events carrying size telemetry (PostHog,
 * status=done, to 2026-07-23). Small sample (a handful of runs), so these are
 * priors leaning toward the p75, not a regression - refine as data accrues.
 * kb: 14-25s/page observed; testGenerator: ~3 tests/page x ~105s/test.
 */
export const STEP_MS_PER_PAGE: Partial<Record<StepName, number>> = {
    kb: 25_000,
    testGenerator: 300_000,
};
