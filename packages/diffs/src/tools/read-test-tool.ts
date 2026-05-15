import { tool } from "ai";
import { z } from "zod";
import type { ExistingTestInfo } from "../diffs-agent";

const readTestSchema = z.object({
    slug: z.string().describe("The slug of the test to read."),
});

export function buildReadTestTool(tests: ExistingTestInfo[]) {
    const testsBySlug = new Map(tests.map((t) => [t.slug, t]));

    return tool({
        description: "Read the full instruction (prompt) of a specific test by its slug.",
        inputSchema: readTestSchema,
        execute: async ({ slug }) => {
            const test = testsBySlug.get(slug);
            if (test == null) {
                return { error: `Test "${slug}" not found.` };
            }
            return { slug, name: test.name, instruction: test.prompt, quarantine: test.quarantine };
        },
    });
}
