import type { CreatedTest, DiffsAgentResult, HealingAction, HealingResult } from "@autonoma/diffs";
import { describe, expect, it } from "vitest";
import { checkAnalysisResult } from "../evals/analysis/analysis-frontmatter";
import type { CodebaseCoords } from "../evals/framework";
import { type HealingCase, validateHealingCase } from "../evals/healing/healing-evaluation";
import { checkHealingResult } from "../evals/healing/healing-frontmatter";

const coords: CodebaseCoords = {
    owner: "acme",
    repo: "web",
    installationId: 1,
    baseSha: "base000",
    headSha: "head111",
};

function diffsResult(createdTests: CreatedTest[]): DiffsAgentResult {
    return { affectedTests: [], createdTests, reasoning: "ok" };
}

function createdTest(overrides: Partial<CreatedTest> = {}): CreatedTest {
    return {
        name: "New checkout promo flow",
        folderName: "Checkout",
        description: "A shopper applying a valid promo code at checkout sees the order total drop by the discount.",
        plan: "Apply a promo code at checkout and verify the discount.",
        coverageJustification: "No existing test exercises the promo-code field added by this diff.",
        ...overrides,
    };
}

function healingResult(actions: HealingAction[]): HealingResult {
    return { actions, reasoning: "ok" };
}

function removeAction(testCaseId: string): HealingAction {
    return {
        kind: "remove_test",
        testCaseId,
        reason: "Test asserts a screen the diff deleted; never a viable flow.",
        reviewLink: { generationReviewId: "gr-1" },
    };
}

function updatePlanAction(testCaseId: string): HealingAction {
    return {
        kind: "update_plan",
        planId: "plan-1",
        testCaseId,
        newPrompt: "Updated instructions that follow the relocated pay button.",
        reasoning: "The pay button moved behind a modal.",
    };
}

function reportBugAction(testCaseId: string): HealingAction {
    return {
        kind: "report_bug",
        testCaseId,
        title: "Pay button unresponsive",
        description: "Clicking pay does nothing.",
        severity: "high",
        evidence: [],
        reasoning: "Application defect, not a test issue.",
        suspectedCause: {
            explanation: "The pay handler swallows the click without dispatching the charge.",
            codeReferences: [{ file: "src/checkout/PayButton.tsx", lines: "42-58" }],
        },
        reviewLink: { generationReviewId: "gr-2" },
    };
}

function reportUnknownIssueAction(testCaseId: string): HealingAction {
    return {
        kind: "report_unknown_issue",
        testCaseId,
        title: "Pay flow looks broken",
        description: "The charge never completes, but the cause appears to be a backend service not checked out here.",
        severity: "medium",
        evidence: [],
        reasoning: "Suspected application issue we could not ground in the checked-out code.",
        reviewLink: { generationReviewId: "gr-3" },
    };
}

function reportScenarioUnsupportedAction(testCaseId: string): HealingAction {
    return {
        kind: "report_scenario_unsupported",
        testCaseId,
        title: "Refund flow needs a settled order",
        description:
            "The test needs a fully-settled order to refund, but no scenario seeds one. Proposed extension: add a settled order to the 'returning shopper' scenario.",
        severity: "medium",
        evidence: [],
        reasoning:
            "Impossible given the current scenario data - the scenario must be extended, not the plan rewritten.",
        reviewLink: { generationReviewId: "gr-4" },
    };
}

/** A minimal HealingCase carrying only what the load-time validators read. */
function healingCase(
    failures: { testCaseId: string; reviewLink?: { generationReviewId: string } }[],
    frontmatter: HealingCase["frontmatter"],
): HealingCase {
    const fullFailures = failures.map((f, i) => ({
        key: `key-${i}`,
        testCaseId: f.testCaseId,
        testCaseSlug: `slug-${i}`,
        testCaseName: `Test ${i}`,
        planId: `plan-${i}`,
        planPrompt: "Do a thing",
        sourceId: `gen-${i}`,
        sourceStatus: "failed",
        lineage: [],
        steps: [],
        reviewLink: f.reviewLink,
    }));

    return {
        name: "case-under-test",
        dir: "/tmp/case-under-test",
        rubric: "",
        frontmatter,
        input: {
            codebase: coords,
            iteration: 1,
            maxIterations: 3,
            snapshotId: "snap-1",
            applicationId: "app-1",
            organizationId: "org-1",
            priorActions: [],
            failures: fullFailures,
            existingTests: [],
            flowIndex: [],
            planAuthoring: { scenarios: [], flows: [] },
            change: { baseSha: "base000", headSha: "head111" },
            analysisReasoning: "",
        },
    };
}

describe("healing provenance grader", () => {
    it("requires a removed test to be deleted", () => {
        const passing = checkHealingResult(healingResult([removeAction("tc-1")]), {
            provenance: { "tc-1": "removed" },
        });
        expect(passing).toEqual([]);

        const failing = checkHealingResult(healingResult([updatePlanAction("tc-1")]), {
            provenance: { "tc-1": "removed" },
        });
        expect(failing.map((f) => f.check)).toEqual(["provenance.tc-1"]);
    });

    it("accepts any keep action for a pre-existing failing test but rejects removal", () => {
        // The rule is "kept, not deleted" - it does not pin which keep mechanism.
        for (const action of [updatePlanAction("tc-1"), reportBugAction("tc-1"), reportUnknownIssueAction("tc-1")]) {
            expect(checkHealingResult(healingResult([action]), { provenance: { "tc-1": "kept" } })).toEqual([]);
        }

        // Both remove_test and report_scenario_unsupported take the test out of the
        // suite, so neither satisfies a "kept" disposition.
        for (const action of [removeAction("tc-1"), reportScenarioUnsupportedAction("tc-1")]) {
            const rejected = checkHealingResult(healingResult([action]), { provenance: { "tc-1": "kept" } });
            expect(rejected.map((f) => f.check)).toEqual(["provenance.tc-1"]);
        }
    });

    it("flags a provenance test case the agent never acted on", () => {
        const failures = checkHealingResult(healingResult([]), { provenance: { "tc-1": "kept" } });
        expect(failures.map((f) => f.check)).toEqual(["provenance.tc-1"]);
    });
});

describe("healing expectedActions grader", () => {
    it("allows expectedActions to pin only the failures the case cares about", () => {
        const failures = checkHealingResult(healingResult([reportBugAction("tc-1"), updatePlanAction("tc-2")]), {
            expectedActions: { "tc-1": "report_bug" },
        });

        expect(failures).toEqual([]);
    });

    it("still flags a pinned action with the wrong kind", () => {
        const failures = checkHealingResult(healingResult([updatePlanAction("tc-1"), reportBugAction("tc-2")]), {
            expectedActions: { "tc-1": "report_bug" },
        });

        expect(failures.map((f) => f.check)).toEqual(["expectedActions.tc-1"]);
    });
});

describe("validateHealingCase removal citability", () => {
    it("throws when a removal is expected but its failure carries no review to cite", () => {
        expect(() =>
            validateHealingCase(healingCase([{ testCaseId: "tc-1" }], { provenance: { "tc-1": "removed" } })),
        ).toThrow(/no reviewLink/);

        expect(() =>
            validateHealingCase(healingCase([{ testCaseId: "tc-1" }], { expectedActions: { "tc-1": "remove_test" } })),
        ).toThrow(/no reviewLink/);
    });

    it("accepts a removal whose failure carries a review", () => {
        expect(() =>
            validateHealingCase(
                healingCase([{ testCaseId: "tc-1", reviewLink: { generationReviewId: "gr-1" } }], {
                    provenance: { "tc-1": "removed" },
                }),
            ),
        ).not.toThrow();
    });

    it("throws on a provenance key that is not a failing test case", () => {
        expect(() =>
            validateHealingCase(
                healingCase([{ testCaseId: "tc-1", reviewLink: { generationReviewId: "gr-1" } }], {
                    provenance: { "tc-other": "kept" },
                }),
            ),
        ).toThrow(/not in input.failures/);
    });

    it("allows expectedActions to omit failures but rejects unknown keys", () => {
        expect(() =>
            validateHealingCase(
                healingCase([{ testCaseId: "tc-1" }, { testCaseId: "tc-2" }], {
                    expectedActions: { "tc-1": "update_plan" },
                }),
            ),
        ).not.toThrow();

        expect(() =>
            validateHealingCase(
                healingCase([{ testCaseId: "tc-1" }], {
                    expectedActions: { "tc-other": "update_plan" },
                }),
            ),
        ).toThrow(/not in input.failures/);
    });
});

describe("analysis dedup grader", () => {
    it("bounds how many tests create_test may author", () => {
        const result = diffsResult([createdTest(), createdTest({ name: "Second" })]);
        const failures = checkAnalysisResult(result, { createdTests: { count: { maxCount: 1 } } });
        expect(failures.map((f) => f.check)).toEqual(["createdTests.maxCount"]);
    });

    it("rejects a new test authored into an already-covered folder", () => {
        const result = diffsResult([createdTest({ folderName: "Checkout" })]);
        const failures = checkAnalysisResult(result, { createdTests: { folders: { exclude: ["Checkout"] } } });
        expect(failures.map((f) => f.check)).toEqual(["createdTests.folders.exclude"]);
    });

    it("flags an authored test with a blank coverage justification regardless of frontmatter", () => {
        const result = diffsResult([createdTest({ coverageJustification: "   " })]);
        const failures = checkAnalysisResult(result, {});
        expect(failures.map((f) => f.check)).toEqual(["createdTests.coverageJustification"]);
    });

    it("flags an authored test with a trivial description regardless of frontmatter", () => {
        const result = diffsResult([createdTest({ description: "checkout" })]);
        const failures = checkAnalysisResult(result, {});
        expect(failures.map((f) => f.check)).toEqual(["createdTests.description"]);
    });
});
