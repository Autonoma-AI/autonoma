import { Agent, FinishTool, type LanguageModel } from "@autonoma/ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import type { Codebase } from "../../../codebase";
import { BashTool } from "../codebase/bash-tool";
import { GlobTool } from "../codebase/glob-tool";
import { GrepTool } from "../codebase/grep-tool";
import { ListDirectoryTool } from "../codebase/list-directory-tool";
import { ReadFilesTool } from "../codebase/read-files-tool";
import { SubagentLoop, type SubagentResult } from "./subagent-loop";

export type { SubagentResult } from "./subagent-loop";

const SUBAGENT_SYSTEM_PROMPT = `You are a code research assistant. You have tools to explore a codebase: bash (shell commands, mainly git), glob (find files), grep (search content), list_directory (list directories), and read_files (read one or more files in a single call - always batch every path you need into one call).

Follow the instruction you're given. Explore the codebase using the tools, then call \`finish\` with a summary of your findings.

Be thorough but focused - only investigate what's relevant to your instruction.`;

const subagentResultSchema = z.object({
    findings: z.string().describe("A summary of what was found"),
});

export interface SubagentInput {
    instruction: string;
    codebase: Codebase;
}

export interface SubagentConfig {
    model: LanguageModel;
    maxSteps?: number;
}

/**
 * Internal research agent spawned by {@link SubagentTool} to investigate a
 * focused area of the codebase in parallel with the main agent. Reuses the
 * same {@link Codebase} as the parent so the agents see a consistent tree.
 */
export class Subagent extends Agent<SubagentInput, SubagentResult, SubagentLoop> {
    private readonly model: LanguageModel;
    private readonly maxSteps: number;
    private readonly tools = [
        new BashTool(),
        new GlobTool(),
        new GrepTool(),
        new ListDirectoryTool(),
        new ReadFilesTool(),
    ];
    private readonly reportTool = new FinishTool<SubagentResult>({
        description: "Call this when you have completed your research.",
        resultSchema: subagentResultSchema,
    });

    constructor({ model, maxSteps }: SubagentConfig) {
        super();
        this.model = model;
        this.maxSteps = maxSteps ?? 15;
    }

    protected async buildUserPrompt(input: SubagentInput): Promise<ModelMessage[]> {
        return [{ role: "user", content: input.instruction }];
    }

    protected async createLoop(input: SubagentInput): Promise<SubagentLoop> {
        return new SubagentLoop({
            name: "Subagent",
            model: this.model,
            maxSteps: this.maxSteps,
            systemPrompt: SUBAGENT_SYSTEM_PROMPT,
            tools: this.tools,
            reportTool: this.reportTool,
            codebase: input.codebase,
        });
    }
}
