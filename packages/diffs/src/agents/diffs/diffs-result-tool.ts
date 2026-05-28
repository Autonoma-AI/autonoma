import { FixableToolError, ReportResultTool } from "@autonoma/ai";
import { z } from "zod";
import type { DiffsAgentResult } from "./diffs-agent";
import type { DiffsAgentLoop } from "./diffs-agent-loop";

const diffsResultInputSchema = z.object({
    reasoning: z
        .string()
        .min(1, "Reasoning must not be empty")
        .describe("Overall summary of the analysis: what was found, what actions were taken, and why"),
});

type DiffsResultInput = z.infer<typeof diffsResultInputSchema>;

class EmptyReasoningError extends FixableToolError {
    constructor() {
        super("Reasoning must not be empty. Summarise what you found before finishing.");
    }
}

/**
 * Terminal tool for the {@link DiffsAgent}. Reads the affected-test and
 * test-candidate arrays off the loop and merges them with the agent's final
 * reasoning to produce a complete {@link DiffsAgentResult}.
 */
export class DiffsResultTool extends ReportResultTool<DiffsResultInput, DiffsAgentResult, DiffsAgentLoop> {
    constructor() {
        super({
            name: "finish",
            description:
                "Call this tool when you have finished analyzing the diff. " +
                "Provide your overall reasoning and summary. " +
                "All actions (mark_affected_test, explain_merge_conflict, suggest_test) " +
                "should have been called BEFORE calling finish.",
            inputSchema: diffsResultInputSchema,
        });
    }

    async buildResult(input: DiffsResultInput, loop: DiffsAgentLoop): Promise<DiffsAgentResult> {
        if (input.reasoning.trim() === "") throw new EmptyReasoningError();
        return {
            affectedTests: [...loop.affectedTests],
            testCandidates: [...loop.testCandidates],
            reasoning: input.reasoning,
        };
    }
}
