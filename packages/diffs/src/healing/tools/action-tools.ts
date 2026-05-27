import { tool } from "ai";
import {
    type HealingAction,
    removeTestInputSchema,
    reportBugInputSchema,
    reportEngineLimitationInputSchema,
    updatePlanInputSchema,
} from "../actions";

/**
 * Collector that the action tools push into. The agent's tool calls populate
 * this list; the runner reads it after `finish` is called.
 */
export interface HealingActionCollector {
    actions: HealingAction[];
    handledFailureKeys: Set<string>;
    handledTestCaseIds: Set<string>;
}

export function createHealingActionCollector(): HealingActionCollector {
    return {
        actions: [],
        handledFailureKeys: new Set(),
        handledTestCaseIds: new Set(),
    };
}

export interface BuildHealingActionToolsOptions {
    /**
     * testCaseIds that may be targeted by report_bug / report_engine_limitation.
     * Excludes hallucinated IDs and real failures whose source review is missing,
     * so the apply layer always has a review to link evidence to.
     */
    reportableTestCaseIds: Set<string>;
}

export function buildHealingActionTools(
    collector: HealingActionCollector,
    failureKeysByTestCaseId: Map<string, string>,
    options: BuildHealingActionToolsOptions,
) {
    function markHandled(testCaseId: string) {
        const failureKey = failureKeysByTestCaseId.get(testCaseId);
        if (failureKey != null) {
            collector.handledFailureKeys.add(failureKey);
        }
        collector.handledTestCaseIds.add(testCaseId);
    }

    function rejectIfHandled(testCaseId: string) {
        if (!collector.handledTestCaseIds.has(testCaseId)) return undefined;
        const prior = collector.actions.find((a) => actionTestCaseId(a) === testCaseId);
        const priorKind = prior?.kind ?? "unknown";
        return {
            recorded: false,
            error: `testCase ${testCaseId} already has an action this iteration (${priorKind}). Each failure gets exactly one action - pick the most appropriate and drop the others.`,
        };
    }

    function rejectIfNotReportable(testCaseId: string) {
        if (options.reportableTestCaseIds.has(testCaseId)) return undefined;
        return {
            recorded: false,
            error: `testCase ${testCaseId} cannot be the target of report_bug or report_engine_limitation. Either it is not one of this iteration's failing test cases, or its failure has no source review to link evidence to. Pick a different action (update_plan, remove_test) or a different testCaseId from the failure list.`,
        };
    }

    const update_plan = tool({
        description:
            "Update a failing test's plan prompt. Use when the plan instruction is wrong (stale after code change, plan_mismatch verdict, or too vague). The loop re-queues a generation with the new prompt next iteration.",
        inputSchema: updatePlanInputSchema,
        execute: (input) => {
            const rejected = rejectIfHandled(input.testCaseId);
            if (rejected != null) return rejected;
            collector.actions.push({ kind: "update_plan", ...input });
            markHandled(input.testCaseId);
            return { recorded: true };
        },
    });

    const report_bug = tool({
        description:
            "Report a confirmed application bug. Atomic: creates an Issue, links to an existing Bug or creates a new one, and quarantines the test case for this snapshot. The apply layer dedupes against existing bugs and against your other report_bug calls in this batch - just describe each bug you find.",
        inputSchema: reportBugInputSchema,
        execute: (input) => {
            const notReportable = rejectIfNotReportable(input.testCaseId);
            if (notReportable != null) return notReportable;
            const rejected = rejectIfHandled(input.testCaseId);
            if (rejected != null) return rejected;
            collector.actions.push({ kind: "report_bug", ...input });
            markHandled(input.testCaseId);
            return { recorded: true };
        },
    });

    const report_engine_limitation = tool({
        description:
            "Report that the engine/agent cannot drive this scenario and there's no plan workaround. Atomic: creates an Issue with kind=engine_limitation and quarantines the test case for this snapshot.",
        inputSchema: reportEngineLimitationInputSchema,
        execute: (input) => {
            const notReportable = rejectIfNotReportable(input.testCaseId);
            if (notReportable != null) return notReportable;
            const rejected = rejectIfHandled(input.testCaseId);
            if (rejected != null) return rejected;
            collector.actions.push({ kind: "report_engine_limitation", ...input });
            markHandled(input.testCaseId);
            return { recorded: true };
        },
    });

    const remove_test = tool({
        description:
            "Permanently remove a test from the suite because the feature it covered no longer exists in the application. Suite-level delete, not a per-snapshot quarantine.",
        inputSchema: removeTestInputSchema,
        execute: (input) => {
            const rejected = rejectIfHandled(input.testCaseId);
            if (rejected != null) return rejected;
            collector.actions.push({ kind: "remove_test", ...input });
            markHandled(input.testCaseId);
            return { recorded: true };
        },
    });

    return { update_plan, report_bug, report_engine_limitation, remove_test };
}

function actionTestCaseId(a: HealingAction): string {
    return a.testCaseId;
}
