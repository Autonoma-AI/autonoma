import { AgentTool } from "@autonoma/ai";
import type { z } from "zod";
import { updatePlanInputSchema } from "../../../healing/actions";
import type { HealingAgentLoop } from "../healing-agent-loop";
import { recordHealingAction } from "./record-action";

export type UpdatePlanInput = z.infer<typeof updatePlanInputSchema>;

interface UpdatePlanOutput {
    testCaseId: string;
}

/** Action tool: rewrite a failing test's plan prompt. */
export class UpdatePlanTool extends AgentTool<UpdatePlanInput, UpdatePlanOutput, HealingAgentLoop> {
    constructor() {
        super({
            name: "update_plan",
            description:
                "Update a failing test's plan prompt. Use when the plan instruction is wrong (stale after code change, plan_mismatch verdict, or too vague). The loop re-queues a generation with the new prompt next iteration.",
            inputSchema: updatePlanInputSchema,
        });
    }

    protected async execute(input: UpdatePlanInput, loop: HealingAgentLoop): Promise<UpdatePlanOutput> {
        recordHealingAction(loop, { kind: "update_plan", ...input });
        return { testCaseId: input.testCaseId };
    }
}
