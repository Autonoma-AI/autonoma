import { tool } from "ai";
import { z } from "zod";

export const quarantinedTestSchema = z.object({
    slug: z.string().describe("The exact slug of the test to quarantine"),
    reasoning: z.string().describe("Why this test should be quarantined (e.g. the flow it tests no longer exists)"),
});

export type QuarantinedTest = z.infer<typeof quarantinedTestSchema>;

export function buildQuarantineTestTool(collector: { quarantinedTests: QuarantinedTest[] }, validSlugs: Set<string>) {
    return tool({
        description:
            "Quarantine (remove) a test whose flow no longer exists or has been completely removed. " +
            "Use this when a failed test covers functionality that was deleted from the application. " +
            "This is different from report_bug (application bug) and modify_test (stale instruction).",
        inputSchema: quarantinedTestSchema,
        execute: async (input) => {
            if (!validSlugs.has(input.slug)) {
                return {
                    success: false,
                    error: `Invalid slug "${input.slug}". Use one of the exact slugs from the failed tests.`,
                };
            }

            collector.quarantinedTests.push(input);
            return { success: true, slug: input.slug };
        },
    });
}
