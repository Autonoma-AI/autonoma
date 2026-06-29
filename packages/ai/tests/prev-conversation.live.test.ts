import type { ContentPart, ToolSet } from "ai";
import { ToolLoopAgent, stepCountIs, tool, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMessages, extractMessages } from "../src/object/build-messages";
import { MODEL_ENTRIES } from "../src/registry/model-entries";
import { ModelRegistry } from "../src/registry/model-registry";

function logStepContent(content: ContentPart<ToolSet>[]) {
    console.log("Agent step.");
    console.log(
        "Text:",
        content.filter((part) => part.type === "text").map((part) => part.text),
    );
    console.log(
        "Tool calls:",
        content
            .filter((part) => part.type === "tool-call")
            .map((part) => ({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
            })),
    );

    console.log(
        "Tool results:",
        content
            .filter((part) => part.type === "tool-result")
            .map((part) => ({
                toolCallId: part.toolCallId,
                result: part.output,
            })),
    );
}

describe("prev-conversation", () => {
    it("restores messages from a previous conversation", async () => {
        const registry = new ModelRegistry({ models: { GPT: MODEL_ENTRIES.GPT_OSS_120B } });
        const model = registry.getModel({ model: "GPT", tag: "prev-conversation-test" });

        // Track the generated number so we can assert on it later
        const generatedNumbers: number[] = [];

        const firstAgent = new ToolLoopAgent({
            model,
            instructions:
                "You are a helpful assistant. Use the generate_random_number tool when asked. DO NOT generate parallel tool calls in a single step.",
            tools: {
                generate_random_number: tool({
                    description: "Generates a random number between 0 and 1000",
                    inputSchema: z.object({}),
                    execute: async () => {
                        const number = Math.floor(Math.random() * 1000);
                        generatedNumbers.push(number);
                        return { number };
                    },
                }),
            },
            onStepFinish: ({ content }) => logStepContent(content),
            stopWhen: [stepCountIs(10)],
        });

        const firstInput: ModelMessage[] = buildMessages({
            userPrompt: "Generate 5 random numbers using the provided tool.",
        });

        const firstResult = await firstAgent.generate({ messages: firstInput });

        expect(generatedNumbers).toHaveLength(5);

        // Extract the full conversation: input messages + response messages
        const conversationMessages: ModelMessage[] = [...firstInput, ...extractMessages(firstResult)];

        let secondAgentNumbers: number[] = [];

        const secondAgent = new ToolLoopAgent({
            model,
            instructions: "You are a helpful assistant. Answer questions based on the conversation history.",
            tools: {
                tell_numbers: tool({
                    description:
                        "Tells the user the numbers generated in the conversation. Use this to reply to the user.",
                    inputSchema: z.object({ numbers: z.array(z.number()) }),
                    execute: ({ numbers }: { numbers: number[] }) => {
                        secondAgentNumbers = numbers;
                    },
                }),
            },
            onStepFinish: async ({ content }) => logStepContent(content),
            stopWhen: [stepCountIs(10)],
        });

        const secondInput = buildMessages({
            rawMessages: conversationMessages as [ModelMessage, ...ModelMessage[]],
            userPrompt: "use the `tell_numbers` tool to tell me the numbers you generated.",
        });

        await secondAgent.generate({ messages: secondInput });

        expect(secondAgentNumbers).toHaveLength(5);
        expect(secondAgentNumbers).toEqual(generatedNumbers);
    }, 60_000);
});
