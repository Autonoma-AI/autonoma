import { AgentTool, FixableToolError } from "@autonoma/ai";
import { z } from "zod";
import type { ResolutionAgentLoop } from "../resolution-agent-loop";

export const removedTestSchema = z.object({
    slug: z.string().describe("The exact slug of the test to remove"),
    reasoning: z.string().describe("Why this test should be removed (e.g. the flow it tests no longer exists)"),
});

export type RemovedTest = z.infer<typeof removedTestSchema>;

interface RemoveTestOutput {
    slug: string;
}

class InvalidRemovalSlugError extends FixableToolError {
    constructor(
        public readonly slug: string,
        public readonly validSlugs: readonly string[],
    ) {
        super(`Invalid slug "${slug}". Use one of the exact slugs from the failed tests.`);
    }

    override suggestFix(): string {
        if (this.validSlugs.length === 0) return "There are no failed test slugs to remove.";
        return `Failed slugs: ${[...this.validSlugs].join(", ")}`;
    }
}

/** Action tool: remove an obsolete test whose feature no longer exists. */
export class RemoveTestTool extends AgentTool<RemovedTest, RemoveTestOutput, ResolutionAgentLoop> {
    constructor() {
        super({
            name: "remove_test",
            description:
                "Remove a test from the suite when its flow no longer exists or has been completely removed from " +
                "the application. Different from report_bug (application bug) and modify_test (stale instruction).",
            inputSchema: removedTestSchema,
        });
    }

    protected async execute(input: RemovedTest, loop: ResolutionAgentLoop): Promise<RemoveTestOutput> {
        if (!loop.failedSlugs.has(input.slug)) throw new InvalidRemovalSlugError(input.slug, [...loop.failedSlugs]);
        loop.removedTests.push(input);
        return { slug: input.slug };
    }
}
