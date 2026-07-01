import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import type { TestLookupLoop } from "./test-lookup-loop";

const readTestsInputSchema = z.object({
    slugs: z
        .array(z.string())
        .min(1)
        .describe(
            "List of test slugs to read. Pass every slug you need in a single call rather than calling this tool one slug at a time.",
        ),
});

type ReadTestsInput = z.infer<typeof readTestsInputSchema>;

type TestEntry = { name: string; instruction: string } | { error: string };

interface ReadTestsOutput {
    results: Record<string, TestEntry>;
}

/** Read the full instructions of one or more tests by slug. */
export class ReadTestsTool extends AgentTool<ReadTestsInput, ReadTestsOutput, TestLookupLoop> {
    constructor() {
        super({
            name: "read_tests",
            description:
                "Read the full instructions (prompts) of one or more tests by slug in a single call. " +
                "Pass every slug you need in the `slugs` array - do not call this tool repeatedly for individual slugs. " +
                "Returns a `results` object keyed by slug.",
            inputSchema: readTestsInputSchema,
        });
    }

    protected async execute({ slugs }: ReadTestsInput, loop: TestLookupLoop): Promise<ReadTestsOutput> {
        const testsBySlug = new Map(loop.existingTests.map((t) => [t.slug, t]));
        const results: Record<string, TestEntry> = {};
        for (const slug of slugs) {
            const test = testsBySlug.get(slug);
            if (test == null) {
                results[slug] = { error: `Test "${slug}" not found.` };
                continue;
            }
            results[slug] = { name: test.name, instruction: test.prompt };
        }
        return { results };
    }
}
