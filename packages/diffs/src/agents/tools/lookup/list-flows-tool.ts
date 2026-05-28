import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import type { FlowIndex } from "../../../flow-index";
import type { TestLookupLoop } from "./test-lookup-loop";

interface ListFlowsOutput {
    flows: ReturnType<FlowIndex["listFlows"]>;
}

/** List all flows (top-level test folders) in the suite. */
export class ListFlowsTool extends AgentTool<Record<string, never>, ListFlowsOutput, TestLookupLoop> {
    constructor() {
        super({
            name: "list_flows",
            description: "List all flows (folders). Returns the name of each flow.",
            inputSchema: z.object({}),
        });
    }

    protected async execute(_input: Record<string, never>, loop: TestLookupLoop): Promise<ListFlowsOutput> {
        return { flows: loop.flowIndex.listFlows() };
    }
}
