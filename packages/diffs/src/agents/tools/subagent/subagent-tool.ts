import { AgentLoopError, AgentTool, type LanguageModel } from "@autonoma/ai";
import type { ModelMessage } from "ai";
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

    constructor(model: LanguageModel, maxSteps?: number) {
        super({
            name: "subagent",
            description:
                "Spawn a subagent to research a specific part of the codebase in parallel. " +
                "Use this to parallelize investigation - e.g. one subagent per affected file or area. " +
                "Each subagent has a read-only bash tool to explore the source tree. " +
                "Give each subagent a focused, specific instruction.",
            inputSchema: subagentInputSchema,
        });
        this.subagent = new Subagent({ model, maxSteps });
    }

    protected async execute(input: SubagentToolInput, loop: CodebaseLoop): Promise<SubagentResult> {
        try {
            const { result } = await this.subagent.run({ instruction: input.instruction, codebase: loop.codebase });
            return result;
        } catch (error) {
            if (error instanceof AgentLoopError) {
                return this.degradedResult(input.instruction, error);
            }
            throw error;
        }
    }

    /**
     * A research subagent that fails - out of steps, no report tool call, or a dead model call - must not abort
     * the parent agent: the parent should continue with whatever was learned elsewhere. We convert the loop
     * error into a normal {@link SubagentResult} whose findings flag the truncation, salvaging any free-text the
     * subagent had emitted so far.
     *
     * Keyed on {@link AgentLoopError} rather than the individual subclasses, so the salvage covers every way a
     * loop can die - including a provider that gives out mid-research.
     *
     * The truncation is logged at `warn` (not swallowed) so the frequency stays observable.
     */
    private degradedResult(instruction: string, error: AgentLoopError): SubagentResult {
        this.logger.warn("Subagent research truncated before producing findings; continuing with partial results", {
            extra: { instruction, reason: error.message },
        });

        const partialNotes = extractAssistantText(error.conversation);
        const preamble =
            `Research did NOT complete: ${error.message}. This area was not fully investigated - ` +
            "treat the findings below as partial and proceed using information from other sources.";
        const findings = partialNotes != null ? `${preamble}\n\nPartial notes so far:\n${partialNotes}` : preamble;

        return { findings };
    }
}

/** Concatenate the assistant's free-text from a loop conversation, used to salvage partial findings. */
function extractAssistantText(conversation: ModelMessage[]): string | undefined {
    const texts = conversation
        .filter((message) => message.role === "assistant")
        .flatMap((message) => {
            if (typeof message.content === "string") return [message.content];
            return message.content.filter((part) => part.type === "text").map((part) => part.text);
        })
        .map((text) => text.trim())
        .filter((text) => text.length > 0);

    if (texts.length === 0) return undefined;
    return texts.join("\n");
}
