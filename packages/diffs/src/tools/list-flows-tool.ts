import { tool } from "ai";
import { z } from "zod";
import type { FlowIndex } from "../flow-index";

export function buildListFlowsTool(flowIndex: FlowIndex) {
    return tool({
        description: "List all flows (folders). Returns the name of each flow.",
        inputSchema: z.object({}),
        execute: async () => {
            const flows = flowIndex.listFlows();
            return { flows };
        },
    });
}
