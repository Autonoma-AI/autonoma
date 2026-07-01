import type { HealingResult } from "@autonoma/diffs";
import { type CheckFailure, baseFrontmatterSchema } from "@autonoma/evals";
import { z } from "zod";

const ACTION_KINDS = [
    "update_plan",
    "report_bug",
    "report_engine_limitation",
    "report_unknown_issue",
    "report_scenario_unsupported",
    "remove_test",
] as const;

const actionKindSchema = z.enum(ACTION_KINDS);

/**
 * The non-removal actions that keep a failing test in the suite rather than
 * deleting it. `report_scenario_unsupported` is deliberately excluded: like
 * `remove_test` it takes the test out of the suite (the test can never pass until
 * a human extends the scenario), so it is not a "keep" action for the provenance
 * rule.
 */
const KEEP_KINDS = ["update_plan", "report_bug", "report_engine_limitation", "report_unknown_issue"] as const;

const provenanceDispositionSchema = z.enum(["removed", "kept"]);

/**
 * Deterministic checks for a Healing case.
 *
 * `expectedActions` grades the per-failure action union for the test cases a
 * rubric wants to pin exactly. Each entry pins the expected action kind for a
 * specific failing test case; omitted failures are not checked by this
 * deterministic grader and should be covered by the judge rubric or
 * `provenance` when their disposition matters. A modify is `update_plan`, a
 * removal is `remove_test`, and a bug is `report_bug` /
 * `report_engine_limitation`. Healing only heals and culls - it authors no
 * tests.
 *
 * `provenance` grades the remove-vs-keep rule. It is keyed by failing test
 * case and semantic rather than kind-exact:
 *   - `removed` - an invalid test authored *this* snapshot (or whose feature was
 *     deleted): the agent must `remove_test` it. Removal is failure-driven and
 *     citable - the runtime attaches a source review and rejects an uncitable
 *     removal - and `validateHealingCase` refuses a `removed` expectation whose
 *     failure carries no `reviewLink`, so a removal always cites a review.
 *   - `kept` - a *pre-existing* failing test, which is useful and must be
 *     kept: the agent must pick any keep action ({@link KEEP_KINDS})
 *     and must NOT `remove_test` it. This does not pin which keep
 *     mechanism, only that the test is not deleted.
 *
 * Anything subtler (was the rewritten plan sensible? was the bug severity
 * proportionate? is the cited removal reason plausible?) belongs in the judge
 * rubric, not here.
 */
export const healingFrontmatterSchema = baseFrontmatterSchema.extend({
    expectedActions: z.record(z.string(), actionKindSchema).optional(),
    provenance: z.record(z.string(), provenanceDispositionSchema).optional(),
});

export type HealingFrontmatter = z.infer<typeof healingFrontmatterSchema>;

/** Apply the Healing deterministic checks to an agent result. Empty list means all checks passed. */
export function checkHealingResult(result: HealingResult, frontmatter: HealingFrontmatter): CheckFailure[] {
    return [
        ...checkExpectedActions(result, frontmatter.expectedActions),
        ...checkProvenance(result, frontmatter.provenance),
    ];
}

function checkExpectedActions(result: HealingResult, expected: HealingFrontmatter["expectedActions"]): CheckFailure[] {
    if (expected == null) return [];

    const failures: CheckFailure[] = [];
    const emittedByTestCaseId = new Map(result.actions.map((a) => [a.testCaseId, a]));

    // Coverage: every expected entry must have a matching emitted action with the right kind.
    for (const [testCaseId, expectedKind] of Object.entries(expected)) {
        const action = emittedByTestCaseId.get(testCaseId);
        if (action == null) {
            failures.push({
                check: `expectedActions.${testCaseId}`,
                message: `expected ${expectedKind} for ${testCaseId} but no action targeted this test case`,
            });
            continue;
        }
        if (action.kind !== expectedKind) {
            failures.push({
                check: `expectedActions.${testCaseId}`,
                message: `expected ${expectedKind} for ${testCaseId} but got ${action.kind}`,
            });
        }
    }

    return failures;
}

/**
 * Grade the remove-vs-keep rule per provenance-labelled test case. A
 * `removed` test must be deleted (`remove_test`); a `kept` test must be
 * kept under any keep action and never deleted.
 */
function checkProvenance(result: HealingResult, provenance: HealingFrontmatter["provenance"]): CheckFailure[] {
    if (provenance == null) return [];

    const failures: CheckFailure[] = [];
    const actionByTestCaseId = new Map(result.actions.map((a) => [a.testCaseId, a]));

    for (const [testCaseId, disposition] of Object.entries(provenance)) {
        const action = actionByTestCaseId.get(testCaseId);
        if (action == null) {
            failures.push({
                check: `provenance.${testCaseId}`,
                message: `expected this test case to be ${disposition} but no action targeted it`,
            });
            continue;
        }

        if (disposition === "removed" && action.kind !== "remove_test") {
            failures.push({
                check: `provenance.${testCaseId}`,
                message: `expected the invalid new test to be removed (remove_test) but got ${action.kind}`,
            });
            continue;
        }

        // Both remove_test and report_scenario_unsupported take the test out of the
        // suite, so neither keeps a "kept" (must-be-kept) test.
        const isRemoval = action.kind === "remove_test" || action.kind === "report_scenario_unsupported";
        if (disposition === "kept" && isRemoval) {
            failures.push({
                check: `provenance.${testCaseId}`,
                message: `expected the pre-existing failing test to be kept (${KEEP_KINDS.join(" / ")}) but it was removed via ${action.kind}`,
            });
        }
    }

    return failures;
}
