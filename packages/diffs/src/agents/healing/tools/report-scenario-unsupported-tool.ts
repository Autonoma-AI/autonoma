import { AgentTool } from "@autonoma/ai";
import type { z } from "zod";
import { reportScenarioUnsupportedInputSchema } from "../../../healing/actions";
import type { HealingAgentLoop } from "../healing-agent-loop";
import { recordHealingAction, resolveReviewLink } from "./record-action";

export type ReportScenarioUnsupportedInput = z.infer<typeof reportScenarioUnsupportedInputSchema>;

interface ReportScenarioUnsupportedOutput {
    testCaseId: string;
}

/**
 * Action tool: report a test that is impossible given the current scenario data
 * (a true data gap, not a stale plan). Records an Issue without filing a
 * customer-facing Bug AND removes the test from the suite - unlike the other
 * report_* actions, a scenario_unsupported test can never pass until a human
 * extends the scenario (the platform never authors scenarios), so re-running it
 * only re-emits the failure. The proposed scenario extension rides in the Issue
 * description as prose - the human's path to extend the scenario and re-add the
 * test.
 */
export class ReportScenarioUnsupportedTool extends AgentTool<
    ReportScenarioUnsupportedInput,
    ReportScenarioUnsupportedOutput,
    HealingAgentLoop
> {
    constructor() {
        super({
            name: "report_scenario_unsupported",
            description:
                "Report a test that is impossible given the CURRENT scenario data - a true data gap that no plan rewrite can fix, only extending the scenario. Use this instead of update_plan when the scenario itself must grow. Atomic: creates an Issue with kind=scenario_unsupported (no customer-facing Bug) AND removes the test from the suite - unlike the other report_* actions, this test can never pass until a human extends the scenario, so it is removed rather than left to re-fail every snapshot. Weave the proposed scenario extension into the description as prose; it is the human's path to extend the scenario and re-add the test. The platform never authors scenarios automatically.",
            inputSchema: reportScenarioUnsupportedInputSchema,
        });
    }

    protected async execute(
        input: ReportScenarioUnsupportedInput,
        loop: HealingAgentLoop,
    ): Promise<ReportScenarioUnsupportedOutput> {
        const reviewLink = resolveReviewLink(loop, input.testCaseId);
        recordHealingAction(loop, { kind: "report_scenario_unsupported", ...input, reviewLink });
        return { testCaseId: input.testCaseId };
    }
}
