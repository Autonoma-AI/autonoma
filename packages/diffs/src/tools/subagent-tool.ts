import { AI_REQUEST_TIMEOUT_MS } from "@autonoma/ai";
import { type LanguageModel, ToolLoopAgent, hasToolCall, stepCountIs, tool } from "ai";
import { z } from "zod";
import { buildBashTool } from "./bash-tool";
import { buildGlobTool } from "./glob-tool";
import { buildGrepTool } from "./grep-tool";
import { buildReadFileTool } from "./read-file-tool";

const subagentInputSchema = z.object({
    instruction: z
        .string()
        .describe(
            "A focused task for the subagent to perform. " +
                "Be specific about what files, patterns, or areas of the codebase to investigate.",
        ),
});

const subagentResultSchema = z.object({
    findings: z.string().describe("A summary of what was found"),
});

type SubagentResult = z.infer<typeof subagentResultSchema>;

const SUBAGENT_SYSTEM_PROMPT = `You are a code research assistant. You have tools to explore a codebase: bash (shell commands, mainly git), glob (find files), grep (search content), and read_file (read files).

Follow the instruction you're given. Explore the codebase using the tools, then call \`finish\` with a summary of your findings.

Be thorough but focused - only investigate what's relevant to your instruction.`;

/**
 * Builds the tools available to a subagent - the same filesystem tools as the main agent,
 * but without the subagent tool itself (no recursive spawning).
 */
function buildSubagentTools(workingDirectory: string) {
    return {
        bash: buildBashTool(workingDirectory),
        glob: buildGlobTool(workingDirectory),
        grep: buildGrepTool(workingDirectory),
        read_file: buildReadFileTool(workingDirectory),
    };
}

export function buildSubagentTool(model: LanguageModel, workingDirectory: string) {
    return tool({
        description:
            "Spawn a subagent to research a specific part of the codebase in parallel. " +
            "Use this to parallelize investigation - e.g. one subagent per affected file or area. " +
            "Each subagent has glob, grep, and read_file tools. " +
            "Give each subagent a focused, specific instruction.",
        inputSchema: subagentInputSchema,
        execute: async (input) => {
            let result: SubagentResult | undefined;

            const subagent = new ToolLoopAgent({
                model,
                instructions: SUBAGENT_SYSTEM_PROMPT,
                timeout: AI_REQUEST_TIMEOUT_MS,
                tools: {
                    ...buildSubagentTools(workingDirectory),
                    finish: tool({
                        description: "Call this when you have completed your research.",
                        inputSchema: subagentResultSchema,
                        execute: async (output) => {
                            result = output;
                        },
                    }),
                },
                stopWhen: [stepCountIs(15), hasToolCall("finish")],
            });

            await subagent.generate({
                messages: [{ role: "user", content: input.instruction }],
            });

            return { findings: result?.findings ?? "Subagent did not produce findings" };
        },
    });
}
