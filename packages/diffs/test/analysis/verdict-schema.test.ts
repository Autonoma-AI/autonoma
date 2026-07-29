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
        whatHappened: null,
        falsePositiveRisk: null,
        suggestedTestUpdate: null,
        planMismatchNote: null,
        invalidTestNote: null,
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

    it("carries whatHappened but no app-behavior fields on an engine artifact", () => {
        const verdict = toRunVerdict(
            modelVerdict({
                category: "engine_artifact",
                whatHappened: "the native confirm dialog could not be driven",
            }),
        );
        expect(verdict).toMatchObject({
            category: "engine_artifact",
            whatHappened: "the native confirm dialog could not be driven",
        });
        // A coverage fault describes what happened, not app expected-vs-actual, and carries no false-positive check.
        expect("expectedBehavior" in verdict).toBe(false);
        expect("actualBehavior" in verdict).toBe(false);
        expect("falsePositiveRisk" in verdict).toBe(false);
    });

    it("carries the revised plan and post-mortem on a plan_mismatch verdict", () => {
        const verdict = toRunVerdict(
            modelVerdict({
                category: "plan_mismatch",
                suggestedTestUpdate: "Setup / Steps / Verification ...",
                planMismatchNote: "asserted old copy; rewrote to the new label; still failed",
            }),
        );
        expect(verdict).toMatchObject({
            category: "plan_mismatch",
            suggestedTestUpdate: "Setup / Steps / Verification ...",
            planMismatchNote: "asserted old copy; rewrote to the new label; still failed",
        });
        // A plan_mismatch is on the coverage plane - it carries no app expected/actual.
        expect("expectedBehavior" in verdict).toBe(false);
        expect("actualBehavior" in verdict).toBe(false);
    });

    // "No viable rewrite" is a real answer on a plan_mismatch, and the self-heal loop reads an empty rewrite as "keep
    // this test without re-running it". Rejecting the verdict instead would be contained upstream as an
    // engine_artifact - turning this pipeline's flagship outcome into a harness fault and losing the diagnosis.
    it("defaults a plan_mismatch's rewrite and post-mortem to empty rather than rejecting the verdict", () => {
        const verdict = toRunVerdict(
            modelVerdict({ category: "plan_mismatch", suggestedTestUpdate: null, planMismatchNote: null }),
        );

        expect(verdict).toMatchObject({ category: "plan_mismatch", suggestedTestUpdate: "", planMismatchNote: "" });
    });

    it("carries the impossibility note + false-positive check on an invalid_test verdict", () => {
        const verdict = toRunVerdict(
            modelVerdict({
                category: "invalid_test",
                invalidTestNote: "asserts a Reports tab; git history shows it never existed",
                falsePositiveRisk: "checked git blame - the component was never added, so not salvageable",
            }),
        );
        expect(verdict).toMatchObject({
            category: "invalid_test",
            invalidTestNote: "asserts a Reports tab; git history shows it never existed",
            falsePositiveRisk: "checked git blame - the component was never added, so not salvageable",
        });
        // invalid_test is a coverage-plane removal - the app is fine, so it carries no app expected/actual.
        expect("expectedBehavior" in verdict).toBe(false);
        expect("actualBehavior" in verdict).toBe(false);
    });

    it("rejects an invalid_test with no evidence (impossibility must be proven - schema min 1)", () => {
        expect(() =>
            toRunVerdict(
                modelVerdict({
                    category: "invalid_test",
                    invalidTestNote: "not browser-executable",
                    falsePositiveRisk: "none",
                    evidence: [],
                }),
            ),
        ).toThrow();
    });
});
