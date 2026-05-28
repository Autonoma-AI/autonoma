import { AgentTool, type LanguageModel } from "@autonoma/ai";
import { z } from "zod";
import type { CodebaseLoop } from "../codebase/codebase-loop";
import { Subagent, type SubagentResult } from "./subagent";

const subagentInputSchema = z.object({
    instruction: z
        .string()
        .describe(
            "A focused task for the subagent to perform. " +
                "Be specific about what files, patterns, or areas of the codebase to investigate.",
        ),
});

type SubagentToolInput = z.infer<typeof subagentInputSchema>;

/**
 * Spawn a research {@link Subagent} that explores the parent loop's codebase
 * with the same shell + filesystem tools the main agent has. Returns the
 * subagent's free-text findings.
 */
export class SubagentTool extends AgentTool<SubagentToolInput, SubagentResult, CodebaseLoop> {
    private readonly subagent: Subagent;

    constructor(model: LanguageModel) {
        super({
            name: "subagent",
            description:
                "Spawn a subagent to research a specific part of the codebase in parallel. " +
                "Use this to parallelize investigation - e.g. one subagent per affected file or area. " +
                "Each subagent has bash, glob, grep, list_directory and read_files tools. " +
                "Give each subagent a focused, specific instruction.",
            inputSchema: subagentInputSchema,
        });
        this.subagent = new Subagent({ model });
    }

    protected async execute(input: SubagentToolInput, loop: CodebaseLoop): Promise<SubagentResult> {
        const { result } = await this.subagent.run({ instruction: input.instruction, codebase: loop.codebase });
        return result;
    }
}
