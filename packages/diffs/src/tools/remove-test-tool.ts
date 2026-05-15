import { tool } from "ai";
import { z } from "zod";

export const removedTestSchema = z.object({
    slug: z.string().describe("The exact slug of the test to remove"),
    reasoning: z.string().describe("Why this test should be removed (e.g. the flow it tests no longer exists)"),
});

export type RemovedTest = z.infer<typeof removedTestSchema>;

export function buildRemoveTestTool(collector: { removedTests: RemovedTest[] }, validSlugs: Set<string>) {
    return tool({
        description:
            "Remove a test from the suite when its flow no longer exists or has been completely removed from " +
            "the application. Different from report_bug (application bug) and modify_test (stale instruction).",
        inputSchema: removedTestSchema,
        execute: async (input) => {
            if (!validSlugs.has(input.slug)) {
                return {
                    success: false,
                    error: `Invalid slug "${input.slug}". Use one of the exact slugs from the failed tests.`,
                };
            }

            collector.removedTests.push(input);
            return { success: true, slug: input.slug };
        },
    });
}
