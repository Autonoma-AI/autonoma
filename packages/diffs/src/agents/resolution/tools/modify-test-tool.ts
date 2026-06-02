import { AgentTool, FixableToolError } from "@autonoma/ai";
import { z } from "zod";
import type { ResolutionAgentLoop } from "../resolution-agent-loop";
import { recordResolutionAction } from "./record-action";

export const modifyTestSchema = z.object({
    slug: z.string().describe("The exact slug of the test to modify (must match a slug from the verdicts)"),
    newInstruction: z
        .string()
        .describe("The updated test instruction in natural language. Must be a complete rewrite, not a patch."),
    reasoning: z.string().describe("Why this test needs modification and what changed"),
});

export type ModifiedTest = z.infer<typeof modifyTestSchema>;

interface ModifyTestOutput {
    slug: string;
}

class UnknownSlugError extends FixableToolError {
    constructor(
        public readonly slug: string,
        public readonly validSlugs: readonly string[],
    ) {
        super(`Unknown test slug: ${slug}.`);
    }

    override suggestFix(): string {
        if (this.validSlugs.length === 0) return "There are no failed test slugs available to modify.";
        return `Valid slugs: ${[...this.validSlugs].join(", ")}`;
    }
}

class QuarantinedSlugError extends FixableToolError {
    constructor(public readonly slug: string) {
        super(
            `Test "${slug}" is quarantined in this snapshot. Modifying it has no effect because generation is gated for quarantined tests.`,
        );
    }
}

/** Action tool: rewrite a stale test instruction (for agent_error verdicts). */
export class ModifyTestTool extends AgentTool<ModifiedTest, ModifyTestOutput, ResolutionAgentLoop> {
    constructor() {
        super({
            name: "modify_test",
            description:
                "Rewrite a test instruction because the UI or flow it describes has changed. " +
                "Use this when the reviewer verdict is 'agent_error' - meaning the test instruction is stale, not that the application has a bug. " +
                "You MUST explore the codebase first to understand the current state before writing the new instruction. " +
                "Do NOT use this tool on quarantined tests - their generation is gated and the change will be dead-weight.",
            inputSchema: modifyTestSchema,
        });
    }

    protected async execute(input: ModifiedTest, loop: ResolutionAgentLoop): Promise<ModifyTestOutput> {
        if (!loop.failedSlugs.has(input.slug)) throw new UnknownSlugError(input.slug, [...loop.failedSlugs]);
        if (loop.quarantinedSlugs.has(input.slug)) throw new QuarantinedSlugError(input.slug);
        recordResolutionAction(loop, input.slug, "modify_test");
        loop.modifiedTests.push(input);
        return { slug: input.slug };
    }
}
