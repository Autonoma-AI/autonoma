import { type LanguageModel, ToolLoopAgent, hasToolCall, stepCountIs, tool } from "ai";
import { z } from "zod";
import { AI_MAX_RETRIES } from "../core/model";
import { pickString } from "../core/pick-string";
import { buildBashTool } from "./bash";
import { buildGlobTool } from "./glob";
import { buildGrepTool } from "./grep";
import { buildReadFileTool } from "./read-file";

const inputSchema = z.object({
    instruction: z
        .string()
        .describe("Focused task for the subagent. Be specific about files and patterns to investigate."),
});

const resultSchema = z.object({
    findings: z.string().describe("Summary of what was found"),
});

type SubagentResult = z.infer<typeof resultSchema>;

const SYSTEM_PROMPT = `You are a code research assistant. You have tools to explore a codebase: bash (shell commands, mainly git), glob (find files), grep (search content), and read_file (read files).

Follow the instruction you're given. Explore the codebase, then call finish with a summary of your findings.

Be thorough but focused - only investigate what's relevant to your instruction.`;

function buildSubagentTools(workingDirectory: string, onFileRead?: (path: string) => void) {
    const baseReadFile = buildReadFileTool(workingDirectory);
    const readFile = onFileRead
        ? tool({
              description: baseReadFile.description,
              inputSchema: baseReadFile.inputSchema,
              execute: async (input, options) => {
                  const filePath = pickString(input, ["filePath", "path", "file_path"]) ?? "";
                  onFileRead(filePath);
                  return baseReadFile.execute!(input, options);
              },
          })
        : baseReadFile;

    return {
        bash: buildBashTool(workingDirectory),
        glob: buildGlobTool(workingDirectory),
        grep: buildGrepTool(workingDirectory),
        read_file: readFile,
    };
}

export function buildSubagentTool(
    model: LanguageModel,
    workingDirectory: string,
    onHeartbeat?: () => void,
    onFileRead?: (path: string) => void,
) {
    return tool({
        description:
            "Spawn a subagent to research a specific part of the codebase. " +
            "Each subagent has glob, grep, read_file, and bash tools. " +
            "Give a focused, specific instruction.",
        inputSchema,
        execute: async (input) => {
            let result: SubagentResult | undefined;

            const subagent = new ToolLoopAgent({
                model,
                maxRetries: AI_MAX_RETRIES,
                instructions: SYSTEM_PROMPT,
                tools: {
                    ...buildSubagentTools(workingDirectory, onFileRead),
                    finish: tool({
                        description: "Call when you have completed your research.",
                        inputSchema: resultSchema,
                        execute: async (output) => {
                            result = output;
                        },
                    }),
                },
                stopWhen: [stepCountIs(15), hasToolCall("finish")],
                onStepFinish: () => {
                    onHeartbeat?.();
                },
            });

            try {
                await subagent.generate({
                    messages: [{ role: "user", content: input.instruction }],
                });
                return { findings: result?.findings ?? "Subagent did not produce findings" };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { findings: `Subagent error: ${message}` };
            }
        },
    });
}
