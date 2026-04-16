import { tool } from "ai";
import { z } from "zod";

export const affectedTestSchema = z.object({
    slug: z.string().describe("The exact slug of the affected test from the Existing Tests list"),
    testName: z.string().describe("The name of the test"),
    reasoning: z.string().describe("Why this test might be affected by the code changes"),
});

export type AffectedTest = z.infer<typeof affectedTestSchema>;

export function buildMarkAffectedTestTool(collector: { affectedTests: AffectedTest[] }, validSlugs: Set<string>) {
    return tool({
        description:
            "Mark an existing test as potentially affected by the code changes. " +
            "Use this when the diff modifies code that a test exercises - e.g. changed UI, " +
            "renamed routes, modified validation logic, or deleted features. " +
            "The test will be run automatically after analysis completes. " +
            "You MUST use the exact slug from the Existing Tests list.",
        inputSchema: affectedTestSchema,
        execute: async (input) => {
            if (!validSlugs.has(input.slug)) {
                return {
                    success: false,
                    error: `Invalid slug "${input.slug}". Use one of the exact slugs from the Existing Tests list.`,
                };
            }

            collector.affectedTests.push(input);
            return { success: true, slug: input.slug };
        },
    });
}
