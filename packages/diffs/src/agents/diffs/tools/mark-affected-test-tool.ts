import { AgentTool, FixableToolError } from "@autonoma/ai";
import { z } from "zod";
import type { DiffsAgentLoop } from "../diffs-agent-loop";

const markAffectedInputSchema = z.object({
    slug: z.string().describe("The exact slug of the affected test from the Existing Tests list"),
    testName: z.string().describe("The name of the test"),
    reasoning: z.string().describe("Why this test might be affected by the code changes"),
});

export type MarkAffectedInput = z.infer<typeof markAffectedInputSchema>;

interface MarkAffectedOutput {
    slug: string;
}

class InvalidSlugError extends FixableToolError {
    constructor(
        public readonly slug: string,
        public readonly validSlugs: readonly string[],
    ) {
        super(`Invalid slug "${slug}". Use one of the exact slugs from the Existing Tests list.`);
    }

    override suggestFix(): string {
        if (this.validSlugs.length === 0) return "No valid slugs are listed - there are no existing tests.";
        const preview = this.validSlugs.slice(0, 5).join(", ");
        const more = this.validSlugs.length > 5 ? `, ... (${this.validSlugs.length} total)` : "";
        return `Use one of: ${preview}${more}.`;
    }
}

/**
 * Action tool: flag an existing test as `code_change`-affected. The agent must
 * supply a slug from the Existing Tests list.
 */
export class MarkAffectedTestTool extends AgentTool<MarkAffectedInput, MarkAffectedOutput, DiffsAgentLoop> {
    constructor() {
        super({
            name: "mark_affected_test",
            description:
                "Mark an existing test as potentially affected by the code changes. " +
                "Use this when the diff modifies code that a test exercises - e.g. changed UI, " +
                "renamed routes, modified validation logic, or deleted features. " +
                "The test will be run automatically after analysis completes. " +
                "You MUST use the exact slug from the Existing Tests list. " +
                "Do NOT use this tool for pre-classified merge conflicts - use `explain_merge_conflict` for those.",
            inputSchema: markAffectedInputSchema,
        });
    }

    protected async execute(input: MarkAffectedInput, loop: DiffsAgentLoop): Promise<MarkAffectedOutput> {
        if (!loop.validSlugs.has(input.slug)) throw new InvalidSlugError(input.slug, [...loop.validSlugs]);

        loop.affectedTests.push({
            slug: input.slug,
            testName: input.testName,
            reasoning: input.reasoning,
            affectedReason: "code_change",
        });
        return { slug: input.slug };
    }
}
