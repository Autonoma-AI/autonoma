import { describe, expect, it } from "vitest";
import type { PreviewBuildWarrantReason } from "../src/activities";
import {
    unconditionalWarrant,
    warrantForJudgedHead,
    warrantFromSelection,
    warrantsBuild,
} from "../src/rules/build-warrant";

// The complete truth table: every reason appears exactly once, so a wrong one fails a named assertion.

describe("unconditionalWarrant", () => {
    const cases: Array<
        [
            string,
            { prNumber: number; everPreviewed: boolean; onboardingComplete: boolean },
            PreviewBuildWarrantReason | undefined,
        ]
    > = [
        [
            "the main-branch environment has no diff to judge",
            { prNumber: 0, everPreviewed: false, onboardingComplete: true },
            "main_branch_preview",
        ],
        [
            "a main-branch environment that has been previewed is still main",
            { prNumber: 0, everPreviewed: true, onboardingComplete: true },
            "main_branch_preview",
        ],
        [
            "a branch the customer has already seen a URL for keeps refreshing",
            { prNumber: 7, everPreviewed: true, onboardingComplete: true },
            "branch_already_previewed",
        ],
        [
            "a first-ever preview on a real PR is the selection's to decide",
            { prNumber: 7, everPreviewed: false, onboardingComplete: true },
            undefined,
        ],
        [
            "an app still onboarding has no suite for the selection to be about",
            { prNumber: 7, everPreviewed: false, onboardingComplete: false },
            "onboarding_incomplete",
        ],
    ];

    for (const [name, facts, expected] of cases) {
        it(name, () => {
            expect(unconditionalWarrant(facts)).toBe(expected);
        });
    }

    // Both build, so a test asserting only "a build started" cannot tell them apart.
    it("distinguishes the two unconditional reasons", () => {
        expect(unconditionalWarrant({ prNumber: 0, everPreviewed: true, onboardingComplete: true })).not.toBe(
            unconditionalWarrant({ prNumber: 7, everPreviewed: true, onboardingComplete: true }),
        );
    });
});

describe("warrantFromSelection", () => {
    const cases: Array<[string, number, PreviewBuildWarrantReason]> = [
        ["a selection with work in it warrants the build", 3, "analysis_selected_tests"],
        ["one selected test is enough", 1, "analysis_selected_tests"],
        ["an empty selection needs no live environment", 0, "no_test_work"],
    ];

    for (const [name, selected, reason] of cases) {
        it(name, () => {
            expect(warrantFromSelection(selected)).toBe(reason);
        });
    }
});

describe("warrantForJudgedHead", () => {
    it("rebuilds a commit that was built before", () => {
        expect(warrantForJudgedHead(true)).toBe("head_already_analyzed");
    });

    // The verdict cannot be re-derived without a run, so the absence of a prior attempt is what carries it forward.
    it("honours the earlier refusal when no build was ever attempted", () => {
        expect(warrantForJudgedHead(false)).toBe("no_test_work");
    });
});

/** Asserted over the whole union, so a reason added without a decision here fails to compile. */
describe("warrantsBuild", () => {
    const cases: Array<[PreviewBuildWarrantReason, boolean]> = [
        ["main_branch_preview", true],
        ["branch_not_resolvable", true],
        ["head_already_analyzed", true],
        ["branch_already_previewed", true],
        ["force_build", true],
        ["analysis_selected_tests", true],
        ["onboarding_incomplete", true],
        ["no_test_work", false],
        // Fails closed: analysis threw, so nothing can say the commit deserved a preview.
        ["analysis_indeterminate", false],
    ];

    for (const [reason, build] of cases) {
        it(`${reason} ${build ? "builds" : "does not build"}`, () => {
            expect(warrantsBuild(reason)).toBe(build);
        });
    }

    it("covers every reason in the union", () => {
        const decided: Record<PreviewBuildWarrantReason, boolean> = {
            main_branch_preview: true,
            branch_not_resolvable: true,
            head_already_analyzed: true,
            branch_already_previewed: true,
            force_build: true,
            analysis_selected_tests: true,
            onboarding_incomplete: true,
            no_test_work: false,
            analysis_indeterminate: false,
        };
        expect(cases.map(([reason]) => reason).sort()).toEqual(Object.keys(decided).sort());
    });
});
