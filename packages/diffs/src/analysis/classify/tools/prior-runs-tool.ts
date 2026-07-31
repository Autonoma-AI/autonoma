import { AgentTool, FixableToolError } from "@autonoma/ai";
import { causeMessage } from "@autonoma/errors";
import { z } from "zod";
import { truncateOutput } from "../../../agents/tools/truncate-output";

const MAX_CHARS = 24_000;

class PriorRunsUnreadableError extends FixableToolError {
    constructor(cause: unknown) {
        super(`Could not read this test's prior runs: ${causeMessage(cause)}`);
    }

    override suggestFix(): string {
        return "Proceed without the baseline, but do NOT assume this test ever passed: an unvalidated test makes plan_mismatch likelier than client_bug. Say in your verdict that you could not establish the baseline.";
    }
}

/** The baseline tool: has this test ever passed? Call FIRST to set the prior. */
export class PriorRunsTool extends AgentTool<Record<string, never>, string> {
    constructor(private readonly loadBaseline: () => Promise<string>) {
        super({
            name: "prior_runs",
            description:
                "The prior run history for THIS test (most recent first, across branches): has it EVER passed, when last, and the recent pass/fail pattern. CALL THIS FIRST - it sets your baseline. A prior pass proves the test+scenario were valid then; never having passed means the test/scenario may be broken from genesis - do not blame the PR. " +
                `Output is capped at ${MAX_CHARS} characters (oldest history is elided first).`,
            inputSchema: z.object({}),
        });
    }

    protected async execute(): Promise<string> {
        try {
            const baseline = await this.loadBaseline();
            return truncateOutput(baseline, MAX_CHARS, "history");
        } catch (cause) {
            throw new PriorRunsUnreadableError(cause);
        }
    }
}
