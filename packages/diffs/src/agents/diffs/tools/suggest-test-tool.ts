import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import type { DiffsAgentLoop } from "../diffs-agent-loop";

export const testCandidateSchema = z.object({
    name: z.string().describe("Test name"),
    instruction: z
        .string()
        .describe("High level description for the test. We'll iron-out the details in a later step."),
    reasoning: z.string().describe("Why this test should be created based on the diff"),
});

export type TestCandidate = z.infer<typeof testCandidateSchema>;

interface SuggestTestOutput {
    testName: string;
}

/** Action tool: suggest a new test for uncovered functionality. */
export class SuggestTestTool extends AgentTool<TestCandidate, SuggestTestOutput, DiffsAgentLoop> {
    constructor() {
        super({
            name: "suggest_test",
            description:
                "Suggest a new test for functionality that has no test coverage. " +
                "Use this when the diff introduces new user-facing behavior that no existing test covers. " +
                "The test will be reviewed and potentially created in a later step.",
            inputSchema: testCandidateSchema,
        });
    }

    protected async execute(input: TestCandidate, loop: DiffsAgentLoop): Promise<SuggestTestOutput> {
        loop.testCandidates.push(input);
        return { testName: input.name };
    }
}
