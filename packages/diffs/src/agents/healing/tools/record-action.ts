import { FixableToolError } from "@autonoma/ai";
import type { HealingAction } from "../../../healing/actions";
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

/**
 * Atomically record an action onto the loop, enforcing the "one action per
 * test case per iteration" invariant. Throws a fixable error if the test case
 * already has an action so the model can choose which one to keep.
 *
 * Free function rather than a method on the loop because the loop favours
 * direct-field interaction; this helper just bundles the three writes that
 * always go together (push action, mark handled, mark failure-key handled).
 */
export function recordHealingAction(loop: HealingAgentLoop, action: HealingAction): void {
    if (
        (action.kind === "report_bug" || action.kind === "report_engine_limitation") &&
        !loop.reportableTestCaseIds.has(action.testCaseId)
    ) {
        throw new UnreportableActionError(action.testCaseId);
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
