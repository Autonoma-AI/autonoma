import { tool } from "ai";
import { z } from "zod";
import type { FlowIndex } from "../flow-index";
import type { TestDirectory } from "../test-directory";

const listTestsSchema = z.object({
    flowName: z.string().describe("The name of the flow (folder) to list tests for."),
});

export function buildListTestsTool(flowIndex: FlowIndex, testDirectory: TestDirectory) {
    return tool({
        description:
            "List all tests in a specific flow (folder). Returns the slug and name of each test. " +
            "Use read_test to read the full instruction of a specific test.",
        inputSchema: listTestsSchema,
        execute: async ({ flowName }) => {
            const slugs = flowIndex.getTestSlugs(flowName);
            if (slugs == null) {
                return { error: `Flow "${flowName}" not found. Use the flows listed in the system prompt.` };
            }

            const tests: Array<{ slug: string; name: string }> = [];
            for (const slug of slugs) {
                const test = await testDirectory.readTest(slug);
                tests.push({ slug, name: test?.name ?? slug });
            }

            return { flowName, tests, count: tests.length };
        },
    });
}
