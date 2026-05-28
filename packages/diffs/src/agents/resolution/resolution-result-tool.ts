import { FixableToolError, ReportResultTool } from "@autonoma/ai";
import { z } from "zod";
import type { ResolutionAgentResult } from "./resolution-agent";
import type { ResolutionAgentLoop } from "./resolution-agent-loop";

const resolutionResultInputSchema = z.object({
    reasoning: z
        .string()
        .min(1, "Reasoning must not be empty")
        .describe(
            "Overall summary of the resolution: what patterns you found across failures, what tests were modified, removed, or created, what bugs were reported, and why",
        ),
});

type ResolutionResultInput = z.infer<typeof resolutionResultInputSchema>;

class EmptyReasoningError extends FixableToolError {
    constructor() {
        super("Reasoning must not be empty. Summarise what you did before finishing.");
    }
}

class UnhandledFailedSlugsError extends FixableToolError {
    constructor(public readonly slugs: readonly string[]) {
        super(
            `You have not handled all failed tests. The following slugs still need action (modify_test, remove_test, or report_bug): ${slugs.join(", ")}`,
        );
    }
}

/**
 * Terminal tool for the {@link ResolutionAgent}. Enforces that every failed
 * test has been acted on (modify / remove / report_bug) before letting the
 * agent finish; otherwise raises a fixable error and lets the agent retry.
 */
export class ResolutionResultTool extends ReportResultTool<
    ResolutionResultInput,
    ResolutionAgentResult,
    ResolutionAgentLoop
> {
    constructor() {
        super({
            name: "finish",
            description:
                "Call this tool when you have finished resolving all test failures. " +
                "Provide your overall reasoning and summary. " +
                "All actions (modify_test, remove_test, report_bug, add_test) should have been called BEFORE calling finish. " +
                "You MUST handle every failed test before finishing.",
            inputSchema: resolutionResultInputSchema,
        });
    }

    async buildResult(input: ResolutionResultInput, loop: ResolutionAgentLoop): Promise<ResolutionAgentResult> {
        if (input.reasoning.trim() === "") throw new EmptyReasoningError();

        const handled = new Set([
            ...loop.modifiedTests.map((t) => t.slug),
            ...loop.removedTests.map((t) => t.slug),
            ...loop.reportedBugs.map((b) => b.slug),
        ]);
        const unhandled = [...loop.failedSlugs].filter((slug) => !handled.has(slug));
        if (unhandled.length > 0) throw new UnhandledFailedSlugsError(unhandled);

        return {
            modifiedTests: [...loop.modifiedTests],
            removedTests: [...loop.removedTests],
            reportedBugs: [...loop.reportedBugs],
            newTests: [...loop.newTests],
            reasoning: input.reasoning,
        };
    }
}
