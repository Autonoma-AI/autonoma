import type { HealingResult } from "@autonoma/diffs";
import { type CheckFailure, baseFrontmatterSchema, checkCountBounds, countBoundsSchema } from "@autonoma/evals";
import { z } from "zod";

const ACTION_KINDS = ["update_plan", "report_bug", "report_engine_limitation", "remove_test"] as const;

const actionKindSchema = z.enum(ACTION_KINDS);

/**
 * Deterministic checks for a Healing case.
 *
 * The Healing agent has two output channels and the frontmatter grades both:
 *
 * - `expectedActions` grades the per-failure action union. The healing runtime
 *   enforces a strict 1:1 mapping (every input failure must be handled by
 *   exactly one action, see `healing-result-tool.ts:UnhandledFailuresError`), so
 *   each entry pins the expected action kind for a specific failing test case and
 *   the keyset must equal the set of failing test cases (enforced at load time by
 *   `validateHealingCase`). This subsumes the old resolution
 *   `modified` / `removed` / `reportedBugs` checks: a modify is `update_plan`, a
 *   removal is `remove_test`, a bug is `report_bug` / `report_engine_limitation`.
 * - `newTests` / `acceptsCandidate` / `rejectsCandidate` grade the candidate
 *   channel that rides on the folded-resolution first turn. They are vacuous for
 *   later turns and onboarding, which carry no candidates.
 *
 * Anything subtler (was the rewritten plan sensible? was the bug severity
 * proportionate? is each new-test instruction on-topic?) belongs in the judge
 * rubric, not here.
 */
export const healingFrontmatterSchema = baseFrontmatterSchema.extend({
    expectedActions: z.record(z.string(), actionKindSchema).optional(),
    /** Inclusive bounds on how many new tests the agent added this turn. */
    newTests: countBoundsSchema.optional(),
    /** Candidate ids that MUST be accepted - each appears as some `newTests[].acceptingCandidateId`. */
    acceptsCandidate: z.array(z.string()).optional(),
    /** Candidate ids that MUST be rejected - each appears as some `rejectedCandidates[].candidateId`. */
    rejectsCandidate: z.array(z.string()).optional(),
});

export type HealingFrontmatter = z.infer<typeof healingFrontmatterSchema>;

/** Apply the Healing deterministic checks to an agent result. Empty list means all checks passed. */
export function checkHealingResult(result: HealingResult, frontmatter: HealingFrontmatter): CheckFailure[] {
    return [
        ...checkExpectedActions(result, frontmatter.expectedActions),
        ...checkNewTests(result, frontmatter.newTests),
        ...checkAcceptsCandidate(result, frontmatter.acceptsCandidate),
        ...checkRejectsCandidate(result, frontmatter.rejectsCandidate),
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

function checkNewTests(result: HealingResult, bounds: HealingFrontmatter["newTests"]): CheckFailure[] {
    if (bounds == null) return [];
    return checkCountBounds("newTests", result.newTests.length, bounds);
}

function checkAcceptsCandidate(
    result: HealingResult,
    acceptsCandidate: HealingFrontmatter["acceptsCandidate"],
): CheckFailure[] {
    if (acceptsCandidate == null) return [];

    const acceptedIds = new Set(
        result.newTests.map((t) => t.acceptingCandidateId).filter((id): id is string => id != null),
    );
    const missing = acceptsCandidate.filter((id) => !acceptedIds.has(id));
    if (missing.length === 0) return [];

    return [
        {
            check: "acceptsCandidate",
            message: `expected the agent to accept candidates [${missing.join(", ")}] but it did not (accepted: [${[...acceptedIds].join(", ")}])`,
        },
    ];
}

function checkRejectsCandidate(
    result: HealingResult,
    rejectsCandidate: HealingFrontmatter["rejectsCandidate"],
): CheckFailure[] {
    if (rejectsCandidate == null) return [];

    const rejectedIds = new Set(result.rejectedCandidates.map((c) => c.candidateId));
    const missing = rejectsCandidate.filter((id) => !rejectedIds.has(id));
    if (missing.length === 0) return [];

    return [
        {
            check: "rejectsCandidate",
            message: `expected the agent to reject candidates [${missing.join(", ")}] but it did not (rejected: [${[...rejectedIds].join(", ")}])`,
        },
    ];
}
