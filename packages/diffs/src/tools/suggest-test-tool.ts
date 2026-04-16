import { tool } from "ai";
import { z } from "zod";

export const testCandidateSchema = z.object({
    name: z.string().describe("Test name"),
    instruction: z
        .string()
        .describe("High level description for the test. We'll iron-out the details in a later step."),
    reasoning: z.string().describe("Why this test should be created based on the diff"),
});

export type TestCandidate = z.infer<typeof testCandidateSchema>;

export function buildSuggestTestTool(collector: { testCandidates: TestCandidate[] }) {
    return tool({
        description:
            "Suggest a new test for functionality that has no test coverage. " +
            "Use this when the diff introduces new user-facing behavior that no existing test covers. " +
            "The test will be reviewed and potentially created in a later step.",
        inputSchema: testCandidateSchema,
        execute: async (input) => {
            collector.testCandidates.push(input);
            return { success: true, testName: input.name };
        },
    });
}
