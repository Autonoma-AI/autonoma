import { AgentTool } from "@autonoma/ai";
import type { z } from "zod";
import { reportEngineLimitationInputSchema } from "../../../healing/actions";
import type { HealingAgentLoop } from "../healing-agent-loop";
import { recordHealingAction } from "./record-action";

export type ReportEngineLimitationInput = z.infer<typeof reportEngineLimitationInputSchema>;

interface ReportEngineLimitationOutput {
    testCaseId: string;
}

/** Action tool: report an engine/agent limitation with no plan workaround. */
export class ReportEngineLimitationTool extends AgentTool<
    ReportEngineLimitationInput,
    ReportEngineLimitationOutput,
    HealingAgentLoop
> {
    constructor() {
        super({
            name: "report_engine_limitation",
            description:
                "Report that the engine/agent cannot drive this scenario and there's no plan workaround. Atomic: creates an Issue with kind=engine_limitation and quarantines the test case for this snapshot.",
            inputSchema: reportEngineLimitationInputSchema,
        });
    }

    protected async execute(
        input: ReportEngineLimitationInput,
        loop: HealingAgentLoop,
    ): Promise<ReportEngineLimitationOutput> {
        recordHealingAction(loop, { kind: "report_engine_limitation", ...input });
        return { testCaseId: input.testCaseId };
    }
}
