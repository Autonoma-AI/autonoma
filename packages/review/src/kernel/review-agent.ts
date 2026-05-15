import { AI_REQUEST_TIMEOUT_MS, type LanguageModel } from "@autonoma/ai";
import { logger } from "@autonoma/logger";
import { ToolLoopAgent, hasToolCall, stepCountIs } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import { extractVerdict } from "./extract-verdict";

const DEFAULT_MAX_STEPS = 15;
const DEFAULT_VERDICT_TOOL_NAME = "submit_verdict";

export interface RunReviewAgentParams {
    model: LanguageModel;
    systemPrompt: string;
    tools: ToolSet;
    messages: ModelMessage[];
    maxSteps?: number;
    verdictToolName?: string;
}

export interface ReviewAgentResult<TVerdict> {
    verdict: TVerdict | undefined;
}

/**
 * Run a review agent loop. Terminates when the model calls the verdict tool
 * (default: `submit_verdict`) or after `maxSteps` iterations.
 *
 * Generic over TVerdict so each reviewer supplies its own verdict shape; the
 * kernel knows nothing about generation/replay outcomes.
 */
export async function runReviewAgent<TVerdict>(params: RunReviewAgentParams): Promise<ReviewAgentResult<TVerdict>> {
    const { model, systemPrompt, tools, messages } = params;
    const maxSteps = params.maxSteps ?? DEFAULT_MAX_STEPS;
    const verdictToolName = params.verdictToolName ?? DEFAULT_VERDICT_TOOL_NAME;

    const agent = new ToolLoopAgent({
        model,
        instructions: systemPrompt,
        tools,
        timeout: AI_REQUEST_TIMEOUT_MS,
        stopWhen: [hasToolCall(verdictToolName), stepCountIs(maxSteps)],
        onStepFinish: (step) => {
            logger.info("Reviewer step finished", {
                finishReason: step.finishReason,
                toolCalls: step.toolCalls.map((tc) => tc.toolName),
                inputTokens: step.usage.inputTokens,
                outputTokens: step.usage.outputTokens,
            });
        },
    });

    const result = await agent.generate({ messages });
    const verdict = extractVerdict<TVerdict>(result.steps, verdictToolName);

    return { verdict };
}
