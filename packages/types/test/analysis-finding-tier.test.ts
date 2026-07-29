import { describe, expect, it } from "vitest";
import {
    analysisFindingBucket,
    analysisFindingSortKey,
    analysisFindingTier,
    analysisVerdictPlane,
    analysisVerdictSchema,
} from "../src/schemas/analysis";

/**
 * The tier partition is THE ordering for every findings list (the report page, the snapshot's suite-changes sections,
 * the Reporter's prompt), and the plane/bucket splits derive from it. These pin the promises those consumers rely on:
 * one order everywhere, and promoting a verdict to its own tier never makes it count against the PR.
 */
describe("analysis finding tiers", () => {
    it("orders a findings list as bugs, then needs-review, then other coverage, then passes", () => {
        const shuffled = ["passed", "engine_artifact", "plan_mismatch", "client_bug", "scenario_issue"];

        const ordered = [...shuffled].sort(
            (left, right) => analysisFindingSortKey(left) - analysisFindingSortKey(right),
        );

        expect(ordered).toEqual(["client_bug", "plan_mismatch", "engine_artifact", "scenario_issue", "passed"]);
    });

    // Its own rank, not the generic coverage one - that distinct rank is what keeps the findings panel's grouping and
    // the order the API and the Reporter emit from drifting apart.
    it("sorts plan_mismatch strictly ahead of every other coverage verdict", () => {
        for (const other of ["engine_artifact", "environment_failure", "scenario_issue"]) {
            expect(analysisFindingSortKey("plan_mismatch")).toBeLessThan(analysisFindingSortKey(other));
        }
    });

    it("keeps plan_mismatch non-blocking despite its own tier", () => {
        expect(analysisFindingTier("plan_mismatch")).toBe("needs_review");
        // Its own presentation tier, but still coverage-plane and counted as coverage - never a bug against the PR.
        expect(analysisVerdictPlane("plan_mismatch")).toBe("coverage");
        expect(analysisFindingBucket("plan_mismatch")).toBe("coverage");
    });

    it("treats an unknown category as non-blocking coverage rather than dropping or convicting it", () => {
        expect(analysisFindingTier("something_new")).toBe("coverage");
        expect(analysisVerdictPlane("something_new")).toBe("coverage");
        expect(analysisFindingBucket("something_new")).toBe("coverage");
    });

    it("assigns exactly one tier to every verdict in the taxonomy", () => {
        for (const verdict of analysisVerdictSchema.options) {
            expect(analysisFindingSortKey(verdict)).toBeTypeOf("number");
        }
        // `client_bug` is the only verdict that counts against the PR.
        const bugs = analysisVerdictSchema.options.filter((verdict) => analysisFindingBucket(verdict) === "bug");
        expect(bugs).toEqual(["client_bug"]);
    });
});
