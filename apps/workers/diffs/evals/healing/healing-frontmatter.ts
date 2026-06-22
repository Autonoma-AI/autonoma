import type { HealingResult } from "@autonoma/diffs";
import { type CheckFailure, baseFrontmatterSchema } from "@autonoma/evals";
import { z } from "zod";

const ACTION_KINDS = ["update_plan", "report_bug", "report_engine_limitation", "remove_test"] as const;

const actionKindSchema = z.enum(ACTION_KINDS);

/** The non-removal actions that quarantine a failing test rather than deleting it from the suite. */
const QUARANTINE_KINDS = ["update_plan", "report_bug", "report_engine_limitation"] as const;

const provenanceDispositionSchema = z.enum(["removed", "quarantined"]);

/**
 * Deterministic checks for a Healing case.
 *
 * `expectedActions` grades the per-failure action union. The healing runtime
 * enforces a strict 1:1 mapping (every input failure must be handled by exactly
 * one action, see `healing-result-tool.ts:UnhandledFailuresError`), so each
 * entry pins the expected action kind for a specific failing test case and the
 * keyset must equal the set of failing test cases (enforced at load time by
 * `validateHealingCase`): a modify is `update_plan`, a removal is `remove_test`,
 * a bug is `report_bug` / `report_engine_limitation`. Healing only heals and
 * culls - it authors no tests.
 *
 * `provenance` grades the remove-vs-quarantine rule. It is keyed by failing test
 * case and semantic rather than kind-exact:
 *   - `removed` - an invalid test authored *this* snapshot (or whose feature was
 *     deleted): the agent must `remove_test` it. Removal is failure-driven and
 *     citable - the runtime attaches a source review and rejects an uncitable
 *     removal - and `validateHealingCase` refuses a `removed` expectation whose
 *     failure carries no `reviewLink`, so a removal always cites a review.
 *   - `quarantined` - a *pre-existing* failing test, which is useful and must be
 *     kept: the agent must pick any quarantine action ({@link QUARANTINE_KINDS})
 *     and must NOT `remove_test` it. Unlike `expectedActions`, this does not pin
 *     which quarantine mechanism, only that the test is not deleted.
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
    const expectedIds = new Set(Object.keys(expected));
    const emittedByTestCaseId = new Map(result.actions.map((a) => [a.testCaseId, a]));
    const emittedIds = new Set(emittedByTestCaseId.keys());

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

    // No extras: the agent must not act on test cases outside the expected set.
    // The healing runtime guarantees every input failure is handled, so the
    // emitted set should equal the expected set; surfacing both directions
    // makes drift loud.
    const unexpected = [...emittedIds].filter((id) => !expectedIds.has(id));
    if (unexpected.length > 0) {
        failures.push({
            check: "expectedActions.unexpected",
            message: `agent acted on test cases not listed in expectedActions: [${unexpected.join(", ")}]`,
        });
    }

    return failures;
}

/**
 * Grade the remove-vs-quarantine rule per provenance-labelled test case. A
 * `removed` test must be deleted (`remove_test`); a `quarantined` test must be
 * kept under any quarantine action and never deleted.
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

        if (disposition === "quarantined" && action.kind === "remove_test") {
            failures.push({
                check: `provenance.${testCaseId}`,
                message: `expected the pre-existing failing test to be quarantined (${QUARANTINE_KINDS.join(" / ")}) but it was removed`,
            });
        }
    }

    return failures;
}
