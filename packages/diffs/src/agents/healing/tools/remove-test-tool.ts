import { AgentTool } from "@autonoma/ai";
import type { z } from "zod";
import { removeTestInputSchema } from "../../../healing/actions";
import type { HealingAgentLoop } from "../healing-agent-loop";
import { recordHealingAction, resolveReviewLink } from "./record-action";

export type HealingRemoveTestInput = z.infer<typeof removeTestInputSchema>;

interface RemoveTestOutput {
    testCaseId: string;
}

/**
 * Action tool: permanently remove an invalid test (or one whose feature was
 * deleted) from the suite. This is the only action that takes a test out of
 * execution - report_* tests keep running every snapshot. Like the report tools,
 * the runner attaches the source review link from the failure that surfaced the
 * problem; the model cannot author it, and a test case with no source review is
 * rejected at the boundary so removal is always failure-driven and citable.
 */
export class HealingRemoveTestTool extends AgentTool<HealingRemoveTestInput, RemoveTestOutput, HealingAgentLoop> {
    constructor() {
        super({
            name: "remove_test",
            description:
                "Permanently remove a test from the suite - the only action that takes a test out of execution (report_* tests keep running every snapshot). Use only for an invalid test (not a viable flow, never useful without becoming a different test) or one whose feature was deleted from the app. NEVER remove a test that merely fails (an application bug or an engine limitation) - report it via report_bug / report_engine_limitation / report_unknown_issue / update_plan instead, so it persists in the suite and can detect a later fix. Requires a cited failure: the call is rejected if the test case has no source review.",
            inputSchema: removeTestInputSchema,
        });
    }

    protected async execute(input: HealingRemoveTestInput, loop: HealingAgentLoop): Promise<RemoveTestOutput> {
        const reviewLink = resolveReviewLink(loop, input.testCaseId);
        recordHealingAction(loop, { kind: "remove_test", ...input, reviewLink });
        return { testCaseId: input.testCaseId };
    }
}
