import { tool } from "ai";
import { z } from "zod";
import type { FlowIndex } from "../flow-index";

export const generatedTestSchema = z.object({
    name: z.string().describe("Test name"),
    folderName: z.string().describe("Name of the folder to add the test to"),
    instruction: z.string().describe("Natural language test instruction"),
    url: z.string().optional().describe("URL to navigate to for the test"),
    reasoning: z.string().describe("Why this test was generated based on the diff"),
});

export type GeneratedTest = z.infer<typeof generatedTestSchema>;

export function buildAddTestTool(collector: { newTests: GeneratedTest[] }, flowIndex: FlowIndex) {
    return tool({
        description:
            "Add a new test for functionality that has no test coverage. " +
            "Use this when the diff introduces new user-facing behavior that no existing test covers.",
        inputSchema: generatedTestSchema,
        execute: async (input) => {
            if (flowIndex.getFlow(input.folderName) === undefined) {
                return { success: false, error: `Folder "${input.folderName}" not found` };
            }
            collector.newTests.push(input);
            return { success: true, testName: input.name };
        },
    });
}
