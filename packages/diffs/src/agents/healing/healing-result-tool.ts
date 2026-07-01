import { FixableToolError, ReportResultTool } from "@autonoma/ai";
import { z } from "zod";
import type { HealingResult } from "./healing-agent";
import type { HealingAgentLoop } from "./healing-agent-loop";

const healingResultInputSchema = z.object({
    reasoning: z
        .string()
        .min(1)
        .describe(
            "One-paragraph summary of what you did: which patterns you found, which tests were updated/reported/removed, which bugs were reported, and why. Goes into the audit trail.",
        ),
});

type HealingResultInput = z.infer<typeof healingResultInputSchema>;

class UnhandledFailuresError extends FixableToolError {
    constructor(public readonly keys: readonly string[]) {
        super(
            `Failure(s) not handled: ${keys.join(", ")}. Each must be addressed by update_plan, report_bug, report_engine_limitation, report_unknown_issue, or remove_test before finishing.`,
        );
    }
}

/**
 * Terminal tool for the {@link HealingAgent}. Lets the agent finish only once
 * every failure key has a corresponding action (update_plan / report_bug /
 * report_engine_limitation / report_unknown_issue / remove_test).
 */
export class HealingResultTool extends ReportResultTool<HealingResultInput, HealingResult, HealingAgentLoop> {
    constructor() {
        super({
            name: "finish",
            description:
                "Call this when you have addressed every failure. The call is rejected if any failure is unhandled (update_plan / report_bug / report_engine_limitation / report_unknown_issue / remove_test).",
            inputSchema: healingResultInputSchema,
        });
    }

    async buildResult(input: HealingResultInput, loop: HealingAgentLoop): Promise<HealingResult> {
        const unhandled = loop.unhandledFailureKeys();
        if (unhandled.length > 0) throw new UnhandledFailuresError(unhandled);

        return {
            actions: [...loop.actions],
            reasoning: input.reasoning,
        };
    }
}
