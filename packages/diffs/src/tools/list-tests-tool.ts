import { tool } from "ai";
import { z } from "zod";
import type { ExistingTestInfo } from "../diffs-agent";
import type { FlowIndex } from "../flow-index";

const listTestsSchema = z.object({
    flowName: z.string().describe("The name of the flow (folder) to list tests for."),
});

export function buildListTestsTool(flowIndex: FlowIndex, tests: ExistingTestInfo[]) {
    const testsBySlug = new Map(tests.map((t) => [t.slug, t]));

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

            const result = slugs.map((slug) => {
                const test = testsBySlug.get(slug);
                return { slug, name: test?.name ?? slug };
            });

            return { flowName, tests: result, count: result.length };
        },
    });
}
