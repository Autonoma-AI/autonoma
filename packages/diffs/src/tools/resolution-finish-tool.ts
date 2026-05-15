import { type ModelMessage, tool } from "ai";
import { z } from "zod";
import type { GeneratedTest } from "./add-test-tool";
import type { ModifiedTest } from "./modify-test-tool";
import type { RemovedTest } from "./remove-test-tool";
import type { ReportedBug } from "./report-bug-tool";

export interface ResolutionAgentResult {
    modifiedTests: ModifiedTest[];
    removedTests: RemovedTest[];
    reportedBugs: ReportedBug[];
    newTests: GeneratedTest[];
    reasoning: string;
    /** Full LLM conversation produced by the agent. Captured so it can be persisted for debugging. */
    conversation: ModelMessage[];
}

export type ResolutionResultCollector = Omit<ResolutionAgentResult, "reasoning" | "conversation">;

/** What the finish tool can produce on its own; the conversation is merged in by the caller. */
export type ResolutionAgentFinishOutput = Omit<ResolutionAgentResult, "conversation">;

const finishSchema = z.object({
    reasoning: z
        .string()
        .describe(
            "Overall summary of the resolution: what patterns you found across failures, what tests were modified, removed, or created, what bugs were reported, and why",
        ),
});

export function buildResolutionFinishTool(
    onFinish: (result: ResolutionAgentFinishOutput) => void,
    collector: ResolutionResultCollector,
    failedSlugs: Set<string>,
) {
    return tool({
        description:
            "Call this tool when you have finished resolving all test failures. " +
            "Provide your overall reasoning and summary. " +
            "All actions (modify_test, remove_test, report_bug, add_test) should have been called BEFORE calling finish. " +
            "You MUST handle every failed test before finishing.",
        inputSchema: finishSchema,
        execute: ({ reasoning }) => {
            const handledSlugs = new Set([
                ...collector.modifiedTests.map((t) => t.slug),
                ...collector.removedTests.map((t) => t.slug),
                ...collector.reportedBugs.map((b) => b.slug),
            ]);

            const unhandled = [...failedSlugs].filter((slug) => !handledSlugs.has(slug));

            if (unhandled.length > 0) {
                return {
                    error: `You have not handled all failed tests. The following slugs still need action (modify_test, remove_test, or report_bug): ${unhandled.join(", ")}`,
                };
            }

            onFinish({ ...collector, reasoning });
            return { success: true };
        },
    });
}
