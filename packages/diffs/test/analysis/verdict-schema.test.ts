import { describe, expect, it } from "vitest";
import { type VerdictForModel, toRunVerdict } from "../../src/analysis/classify/verdict-schema";

/** A fully-populated model output (every field present, per-category-optional fields null), overridden per case. */
function modelVerdict(overrides: Partial<VerdictForModel>): VerdictForModel {
    return {
        category: "passed",
        isClientBug: false,
        ran: true,
        confidence: "high",
        planFidelity: "exact",
        headline: "headline",
        expectedBehavior: null,
        actualBehavior: null,
        falsePositiveRisk: null,
        suggestedTestUpdate: null,
        observedAppIssues: null,
        evidence: [{ source: "run", detail: "what the run showed", file: null, lines: null, snippet: null }],
        keyStepIndex: null,
        ...overrides,
    };
}

describe("toRunVerdict", () => {
    it("narrows a passed verdict to expected/actual and drops the problem-only fields", () => {
        const verdict = toRunVerdict(
            modelVerdict({ category: "passed", expectedBehavior: "cart shows the item", actualBehavior: "it did" }),
        );
        expect(verdict).toMatchObject({
            category: "passed",
            expectedBehavior: "cart shows the item",
            actualBehavior: "it did",
        });
        // A passing finding never carries a false-positive check or remediation-style filler.
        expect("falsePositiveRisk" in verdict).toBe(false);
        expect("suggestedTestUpdate" in verdict).toBe(false);
    });

    it("keeps the false-positive check on a client bug alongside expected/actual", () => {
        const verdict = toRunVerdict(
            modelVerdict({
                category: "client_bug",
                isClientBug: true,
                expectedBehavior: "save persists",
                actualBehavior: "value reverts after reload",
                falsePositiveRisk: "the PR did not intend this",
            }),
        );
        expect(verdict).toMatchObject({
            category: "client_bug",
            expectedBehavior: "save persists",
            actualBehavior: "value reverts after reload",
            falsePositiveRisk: "the PR did not intend this",
        });
    });

    it("rejects a client bug missing its expected behavior (per-category requirement enforced at parse)", () => {
        expect(() =>
            toRunVerdict(
                modelVerdict({
                    category: "client_bug",
                    isClientBug: true,
                    expectedBehavior: null,
                    actualBehavior: "value reverts",
                    falsePositiveRisk: "n/a",
                }),
            ),
        ).toThrow();
    });

    it("carries no behavior fields on an engine artifact", () => {
        const verdict = toRunVerdict(modelVerdict({ category: "engine_artifact" }));
        expect(verdict.category).toBe("engine_artifact");
        expect("expectedBehavior" in verdict).toBe(false);
        expect("actualBehavior" in verdict).toBe(false);
        expect("falsePositiveRisk" in verdict).toBe(false);
    });

    it("carries the revised plan on a wrong-test verdict", () => {
        const verdict = toRunVerdict(
            modelVerdict({ category: "outdated_test", suggestedTestUpdate: "Setup / Steps / Verification ..." }),
        );
        expect(verdict).toMatchObject({
            category: "outdated_test",
            suggestedTestUpdate: "Setup / Steps / Verification ...",
        });
    });
});
