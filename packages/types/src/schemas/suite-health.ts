import { z } from "zod";

/**
 * How much a suite's failures can be trusted, on a five-step ladder. The agent writes a suite from one pass over
 * the code without ever having operated the app, so some of what it wrote is wrong and it only finds out by running
 * against real pull requests. This is how that is said out loud, and how it is shown improving.
 *
 * The ladder is ordered lowest-first so a level's rank is its index + 1 - never hand-list a subset of it.
 */
export const SUITE_HEALTH_LEVELS = ["degraded", "at_risk", "calibrating", "steady", "proven"] as const;

export const suiteHealthLevelSchema = z.enum(SUITE_HEALTH_LEVELS);
export type SuiteHealthLevel = z.infer<typeof suiteHealthLevelSchema>;

/** Every new app starts here: not at zero, not at green. */
export const DEFAULT_SUITE_HEALTH_LEVEL: SuiteHealthLevel = "calibrating";

/** 1-5, the number the meter renders as `{rank}/5`. Derived from the ladder's order. */
export function suiteHealthRank(level: SuiteHealthLevel): number {
    return SUITE_HEALTH_LEVELS.indexOf(level) + 1;
}

/** The level at a given 1-5 rank, clamped to the ladder. Used to walk a level up or down. */
export function suiteHealthLevelAtRank(rank: number): SuiteHealthLevel {
    const index = Math.min(SUITE_HEALTH_LEVELS.length, Math.max(1, Math.round(rank))) - 1;
    // Safe by construction: `index` is clamped into the array's bounds above.
    return SUITE_HEALTH_LEVELS[index] ?? DEFAULT_SUITE_HEALTH_LEVEL;
}

/**
 * The single thing costing this suite the most, so the tooltip can name an action instead of showing an opaque
 * number. Two suites at the same level routinely need opposite things done: one should keep shipping PRs until its
 * tests converge, the other should go fix its preview environment.
 *
 * - `environment` - the preview or its config was unavailable.
 * - `scenario`    - the test data was missing or mis-seeded.
 * - `plan`        - the app rendered correctly but the tests do not match it yet.
 * - `engine`      - our harness flaked or crashed. Ours to fix, never the customer's.
 * - `balanced`    - no cause dominates; there is nothing single to point at.
 * - `none`        - nothing is going wrong.
 */
export const suiteHealthDriverSchema = z.enum(["environment", "scenario", "plan", "engine", "balanced", "none"]);
export type SuiteHealthDriver = z.infer<typeof suiteHealthDriverSchema>;

/**
 * Why a suite is not one level higher than its score alone would put it. A brand-new app must not be able to reach
 * the top of the ladder on three lucky runs, so the gates cap it - and saying which gate is holding it turns "stuck
 * at 3/5" into a progress story.
 */
export const suiteHealthGateSchema = z.enum(["runs", "pull_requests", "age", "stale_issues", "no_triage"]);
export type SuiteHealthGate = z.infer<typeof suiteHealthGateSchema>;

/** The counts behind the meter's `21 runs · 3 PRs · 2 self-heals` line. */
export const suiteHealthEvidenceSchema = z.object({
    /** Analysis runs in the window. A run that selected no tests is not one. */
    runs: z.number().int(),
    /** Distinct branches those runs covered. */
    pullRequests: z.number().int(),
    /** Tests the agent re-planned and re-ran, that then passed. */
    selfHeals: z.number().int(),
    /** Tests the agent re-planned and re-ran at all - the denominator of the self-heal rate. */
    selfHealAttempts: z.number().int(),
    /** Total findings in the window - the denominator of the trust rate. */
    findings: z.number().int(),
    /** Whole days since the app's first analysis run of any pipeline. */
    ageDays: z.number().int(),
    /** Whole days since its most recent run. Drives the inactivity decay. */
    daysSinceLastRun: z.number().int(),
});
export type SuiteHealthEvidence = z.infer<typeof suiteHealthEvidenceSchema>;

/** Findings in the window, split by verdict. The two app-health verdicts are what the trust rate counts. */
export const suiteHealthBreakdownSchema = z.object({
    passed: z.number().int(),
    clientBug: z.number().int(),
    environmentFailure: z.number().int(),
    scenarioIssue: z.number().int(),
    planMismatch: z.number().int(),
    engineArtifact: z.number().int(),
    invalidTest: z.number().int(),
});
export type SuiteHealthBreakdown = z.infer<typeof suiteHealthBreakdownSchema>;

export const suiteHealthSchema = z.object({
    level: suiteHealthLevelSchema,
    /** 1-5. Always `suiteHealthRank(level)`; sent so clients never re-derive it. */
    rank: z.number().int(),
    /** 0-100, after modifiers. Display-only - the level is what surfaces read. */
    score: z.number(),
    /**
     * `(passed + client_bug) / findings`, 0-100, before modifiers. The headline fact: of the tests the agent
     * investigated, how many produced a verdict you can act on.
     */
    trust: z.number(),
    evidence: suiteHealthEvidenceSchema,
    breakdown: suiteHealthBreakdownSchema,
    driver: suiteHealthDriverSchema,
    /** Open issues older than a week on a branch that is still live. What DEGRADED is actually made of. */
    staleIssues: z.number().int(),
    /** The gate holding the level down, if the score alone would have placed it higher. */
    gatedBy: suiteHealthGateSchema.optional(),
    /** False before the first analysis run ever - the meter shows "waiting for your first pull request". */
    hasEverRun: z.boolean(),
});
export type SuiteHealth = z.infer<typeof suiteHealthSchema>;
