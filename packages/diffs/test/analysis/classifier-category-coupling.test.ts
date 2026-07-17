import { describe, expect, it } from "vitest";
import { Category } from "../../src/analysis/schema";

/**
 * Drift guard for the classifier <-> workflow coupling.
 *
 * `routeVerdict` (packages/workflow/src/workflows/investigator.workflow.ts) maps this classifier `Category` enum
 * onto the `AnalysisVerdict` taxonomy, but it HARDCODES the category literals: the Temporal workflow sandbox
 * cannot import `@autonoma/diffs/analysis` to reference the enum by symbol. So if this enum is renamed or extended
 * and `routeVerdict` is not updated in lockstep, a real category silently falls through `routeVerdict`'s default
 * to `engine_artifact` - a stale test would never self-heal or `delete`, with no error.
 *
 * This test (which CAN import the enum) pins the exact set `routeVerdict` was written against. If it fails, update
 * `routeVerdict` + `TEST_IS_WRONG_CATEGORIES` in investigator.workflow.ts to handle the changed categories, then
 * update the expectation here.
 */

// The two `test_is_wrong` categories the workflow routes to a self-heal + eventual `delete`.
const SELF_HEALABLE = ["outdated_test", "bad_test"] as const;
// The categories the workflow passes through 1:1 to the AnalysisVerdict taxonomy.
const TERMINAL_PASSTHROUGH = [
    "passed",
    "client_bug",
    "engine_artifact",
    "environment_failure",
    "scenario_issue",
] as const;

describe("classifier Category <-> routeVerdict coupling", () => {
    it("pins the exact Category set routeVerdict hardcodes", () => {
        // Every classifier category must be explicitly handled by routeVerdict - either self-healable or a
        // passthrough terminal. A category in neither list means routeVerdict silently maps it to engine_artifact.
        expect([...Category.options].sort()).toEqual([...SELF_HEALABLE, ...TERMINAL_PASSTHROUGH].sort());
    });
});
