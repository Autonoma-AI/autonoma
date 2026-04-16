import { tool } from "ai";
import { z } from "zod";

export const modifyTestSchema = z.object({
    slug: z.string().describe("The exact slug of the test to modify (must match a slug from the verdicts)"),
    newInstruction: z
        .string()
        .describe("The updated test instruction in natural language. Must be a complete rewrite, not a patch."),
    reasoning: z.string().describe("Why this test needs modification and what changed"),
});

export type ModifiedTest = z.infer<typeof modifyTestSchema>;

export interface ModifiedTestCollector {
    modifiedTests: ModifiedTest[];
}

export function buildModifyTestTool(collector: ModifiedTestCollector, validSlugs: Set<string>) {
    return tool({
        description:
            "Rewrite a test instruction because the UI or flow it describes has changed. " +
            "Use this when the reviewer verdict is 'agent_error' - meaning the test instruction is stale, not that the application has a bug. " +
            "You MUST explore the codebase first to understand the current state before writing the new instruction.",
        inputSchema: modifyTestSchema,
        execute: async (input) => {
            if (!validSlugs.has(input.slug)) {
                return {
                    success: false,
                    error: `Unknown test slug: ${input.slug}. Valid slugs: ${[...validSlugs].join(", ")}`,
                };
            }

            collector.modifiedTests.push(input);
            return { success: true, slug: input.slug };
        },
    });
}
