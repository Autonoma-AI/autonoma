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

class UncitableActionError extends FixableToolError {
    constructor(public readonly testCaseId: string) {
        super(
            `testCase ${testCaseId} cannot be the target of report_bug, report_engine_limitation, report_unknown_issue, or remove_test. Either it is not one of this iteration's failing test cases, or its failure has no source review to cite. Only update_plan does not require a source review - pick that, or a different testCaseId from the failure list.`,
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
 * Resolve the source review a citing action must link to. A test case is
 * citable iff its failure carries a review link, so this doubles as the
 * citation guard for report_bug / report_engine_limitation /
 * report_unknown_issue / remove_test: it
 * throws a fixable error when the model targets a test case that has none. This
 * is what makes "a generation/run must surface the problem before a test can be
 * removed" a boundary constraint rather than a prompt hope.
 */
export function resolveReviewLink(loop: HealingAgentLoop, testCaseId: string): HealingReviewLink {
    const reviewLink = loop.reviewLinksByTestCaseId.get(testCaseId);
    if (reviewLink == null) throw new UncitableActionError(testCaseId);
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
