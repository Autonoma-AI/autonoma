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
 * ETA budgets per step (ms), used when no size signal applies. `userPaced`
 * marks the step that hands off to the user's own coding agent: its duration
 * reflects the human, not this run's pace, so the ETA neither scales it by the
 * observed pace ratio nor reads a pace from it.
 */
// Budgets come from measured medians in PostHog (cli_step_completed,
// status=done, 90 days to 2026-07-21; ~40-140 completions per step), rounded
// up toward p60 since the distributions are heavily right-skewed with repo
// size.
//
// recipeBuilder is measured over the post-handoff window only (45 days to
// 2026-07-29, n=34) and its distribution is bimodal, not skewed: ~39% of runs
// finish inside a minute because the SDK is already wired and there is nothing
// to hand off, while ~19% run past 20 minutes doing the real integration. No
// single number fits both, so the budget covers the working case (p70 of runs
// that took over a minute) rather than the p90 tail - a step that overruns
// corrects itself from its own observed pace once it starts, whereas budgeted
// time that never gets spent inflates the estimate for the whole run before it.
export const STEP_BUDGET: Record<StepName, { ms: number; userPaced?: true }> = {
    projectMapper: { ms: 3 * MIN },
    pagesFinder: { ms: 3 * MIN },
    kb: { ms: 12 * MIN },
    entityAudit: { ms: 10 * MIN },
    scenarioRecipe: { ms: 3 * MIN },
    recipeBuilder: { ms: 12 * MIN, userPaced: true },
    testGenerator: { ms: 30 * MIN },
};

export interface PageSizing {
    /** The part of the step that does not scale with page count. */
    baseMs: number;
    /** Marginal cost of each page, up to the knee. */
    msPerPage: number;
    /** Page count past which further pages add nothing to the budget. */
    kneePages: number;
}

/**
 * Page-count sizing for the steps whose duration scales with the number of
 * pages, which is known once the pages step completes. Only pages qualify as
 * a predictor today: the other size signals (entities, tests) are produced BY
 * their own steps, so they can't size those budgets ahead of time - the live
 * in-run rate (eta.ts) covers them instead.
 *
 * The curve saturates on purpose. These steps batch and parallelize their
 * work, so measured cost per page collapses as repos grow - kb ran 3.9s/page
 * on an 81-page repo against 15-25s/page on 15-page ones. A flat per-page rate
 * extrapolates that small-repo cost across a large one and predicts multi-hour
 * steps that never happen, so past `kneePages` extra pages are free. The knee
 * is what bounds the estimate: base + msPerPage x kneePages is the most a
 * sized step can ever be budgeted.
 *
 * Measured from cli_step_completed events carrying size telemetry (PostHog,
 * status=done, to 2026-07-29). Small sample (a handful of runs), so these are
 * priors, not a regression - refine as data accrues.
 */
export const STEP_PAGE_SIZING: Partial<Record<StepName, PageSizing>> = {
    kb: { baseMs: 3 * MIN, msPerPage: 20_000, kneePages: 30 },
    testGenerator: { baseMs: 10 * MIN, msPerPage: 2 * MIN, kneePages: 25 },
};
