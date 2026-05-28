import { AgentTool } from "@autonoma/ai";
import type { z } from "zod";
import { removeTestInputSchema } from "../../../healing/actions";
import type { HealingAgentLoop } from "../healing-agent-loop";
import { recordHealingAction } from "./record-action";

export type HealingRemoveTestInput = z.infer<typeof removeTestInputSchema>;

interface RemoveTestOutput {
    testCaseId: string;
}

/** Action tool: permanently remove a test whose feature has been deleted. */
export class HealingRemoveTestTool extends AgentTool<HealingRemoveTestInput, RemoveTestOutput, HealingAgentLoop> {
    constructor() {
        super({
            name: "remove_test",
            description:
                "Permanently remove a test from the suite because the feature it covered no longer exists in the application. Suite-level delete, not a per-snapshot quarantine.",
            inputSchema: removeTestInputSchema,
        });
    }

    protected async execute(input: HealingRemoveTestInput, loop: HealingAgentLoop): Promise<RemoveTestOutput> {
        recordHealingAction(loop, { kind: "remove_test", ...input });
        return { testCaseId: input.testCaseId };
    }
}
