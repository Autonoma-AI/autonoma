import { FixableToolError } from "@autonoma/ai";
import type { HealingAction, HealingReviewLink } from "../../../healing/actions";
import type { HealingAgentLoop } from "../healing-agent-loop";

class DuplicateActionError extends FixableToolError {
    constructor(
        public readonly testCaseId: string,
        public readonly priorKind: string,
    ) {
        super(
            `testCase ${testCaseId} already has an action this iteration (${priorKind}). Each failure gets exactly one action - pick the most appropriate and drop the others.`,
        );
    }
}

class UnreportableActionError extends FixableToolError {
    constructor(public readonly testCaseId: string) {
        super(
            `testCase ${testCaseId} cannot be the target of report_bug or report_engine_limitation. Either it is not one of this iteration's failing test cases, or its failure has no source review to link evidence to. Pick a different action (update_plan, remove_test) or a different testCaseId from the failure list.`,
        );
    }
}

class UnknownTestCaseError extends FixableToolError {
    constructor(public readonly testCaseId: string) {
        super(
            `testCaseId "${testCaseId}" is not one of this iteration's failing test cases, so no action can target it. Copy a testCaseId verbatim from the failure list - do not paste extra text, markdown, or multiple ids into the field.`,
        );
    }
}

/**
 * Resolve the source review a report action must link evidence to. A test case
 * is reportable iff its failure carries a review link, so this doubles as the
 * reportability guard: it throws a fixable error when the model targets a test
 * case that has none.
 */
export function resolveReviewLink(loop: HealingAgentLoop, testCaseId: string): HealingReviewLink {
    const reviewLink = loop.reviewLinksByTestCaseId.get(testCaseId);
    if (reviewLink == null) throw new UnreportableActionError(testCaseId);
    return reviewLink;
}

/**
 * Atomically record an action onto the loop, enforcing the "one action per
 * test case per iteration" invariant. Throws a fixable error if the test case
 * already has an action so the model can choose which one to keep.
 *
 * Free function rather than a method on the loop because the loop favours
 * direct-field interaction; this helper just bundles the three writes that
 * always go together (push action, mark handled, mark failure-key handled).
 *
 * Every per-failure action must target one of this iteration's failing test
 * cases. Rejecting an unknown testCaseId here is the single guard that stops a
 * hallucinated or malformed id (e.g. a valid cuid with extra text pasted onto
 * the end) from being recorded and later crashing the apply step, which expects
 * the test case to have an assignment on the snapshot.
 */
export function recordHealingAction(loop: HealingAgentLoop, action: HealingAction): void {
    if (!loop.failureKeysByTestCaseId.has(action.testCaseId)) {
        throw new UnknownTestCaseError(action.testCaseId);
    }
    if (loop.handledTestCaseIds.has(action.testCaseId)) {
        const prior = loop.actions.find((a) => a.testCaseId === action.testCaseId);
        throw new DuplicateActionError(action.testCaseId, prior?.kind ?? "unknown");
    }
    loop.actions.push(action);
    loop.handledTestCaseIds.add(action.testCaseId);
    const failureKey = loop.failureKeysByTestCaseId.get(action.testCaseId);
    if (failureKey != null) loop.handledFailureKeys.add(failureKey);
}
