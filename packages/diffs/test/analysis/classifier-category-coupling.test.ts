import { analysisVerdictSchema } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { Category } from "../../src/analysis/schema";

/**
 * Drift guard for the classifier <-> platform taxonomy coupling.
 *
 * The Investigator's `routeVerdict` (packages/workflow/src/workflows/investigator.workflow.ts) validates the
 * classifier's `Category` against `AnalysisVerdict` and falls back to `engine_artifact` for anything it does not
 * recognize. That fallback is a runtime safety net for a model returning garbage - it must never be load-bearing for a
 * category we actually ship. If this enum gains or renames a value that the platform taxonomy does not have, every run
 * of it would silently classify as `engine_artifact`: a real verdict lost, with no error.
 *
 * Two separate enums exist only because the Temporal workflow sandbox cannot import `@autonoma/diffs/analysis`. This
 * test can import both, so it pins the one invariant that keeps them interchangeable.
 */
describe("classifier Category <-> AnalysisVerdict coupling", () => {
    it("holds the same values as the platform verdict taxonomy", () => {
        expect([...Category.options].sort()).toEqual([...analysisVerdictSchema.options].sort());
    });
});
