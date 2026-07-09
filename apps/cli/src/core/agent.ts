import { type LanguageModel, type ModelMessage, type ToolSet, ToolLoopAgent, hasToolCall, stepCountIs } from "ai";
import { track } from "./analytics";
import { createStepLogger, type StepInfo } from "./display";
import { AgentError, classifyAgentError, sleep } from "./errors";
import { AI_MAX_RETRIES } from "./model";

const MAX_RETRIES = 3;
const STEP_TIMEOUT_MS = 120_000;

// The tool loop stops as soon as the model calls `finish` - even when the
// finish tool rejected with a validation error - or when the model replies
// with plain text. In both cases no result was captured, so we re-prompt the
// same conversation a bounded number of times instead of failing the step.
const MAX_NUDGES = 2;
const NUDGE_PROMPT =
    "You stopped before completing the task. The task is only complete once the finish tool " +
    "has been called and succeeded. If your last finish call returned an error, fix exactly what " +
    "it reported. Otherwise, continue where you left off and call the finish tool when done.";

export interface AgentConfig {
    id: string;
    systemPrompt: string;
    tools: ToolSet | ((heartbeat: () => void) => ToolSet | Promise<ToolSet>);
    model: LanguageModel;
    maxSteps: number;
    temperature?: number;
    stepTimeoutMs?: number;
    onStepFinish?: (info: StepInfo) => void;
}

export interface AgentContext {
    projectRoot: string;
    outputDir: string;
}

export interface AgentResult {
    success: boolean;
    paused?: boolean;
    artifacts: string[];
    summary: string;
}

/**
 * Block appended to a step's prompt when the user retries a failed step with
 * guidance. Returns "" when there is no guidance so call sites can always
 * interpolate it.
 */
export function formatRetryGuidance(guidance?: string): string {
    if (!guidance?.trim()) return "";
    return (
        `\nA previous attempt at this task did not complete successfully. ` +
        `The user provided this guidance for the retry:\n"${guidance.trim()}"\n`
    );
}

export function buildDefaultStepLogger(agentId: string, maxSteps: number) {
    const logger = createStepLogger(agentId, maxSteps);

    return {
        logger,
        onStepFinish: (info: StepInfo) => {
            logger.log(info);
        },
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildStepHandler(config: AgentConfig) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (step: any) => {
        if (!config.onStepFinish) return;

        const toolErrors: { name: string; error: unknown }[] = [];
        const writtenFiles: string[] = [];

        for (const part of step.content) {
            if (part.type === "tool-error") {
                toolErrors.push({ name: part.toolName, error: part.error });
            }
            if (part.type === "tool-result" && part.toolName === "write_file") {
                const output = part.output;
                if (typeof output === "object" && output !== null && "path" in output) {
                    writtenFiles.push(String(output.path));
                }
            }
        }

        config.onStepFinish({
            stepNumber: step.stepNumber,
            maxSteps: config.maxSteps,
            reasoningText: step.reasoningText ?? undefined,
            text: step.text,
            toolCalls: step.toolCalls.map((tc: { toolName: string; input: Record<string, unknown> }) => ({
                name: tc.toolName,
                input: tc.input,
            })),
            toolErrors,
            writtenFiles,
        });
    };
}

export async function runAgent<T>(
    config: AgentConfig,
    prompt: string,
    extractResult: () => T | undefined,
): Promise<T | undefined> {
    const stepTimeout = config.stepTimeoutMs ?? STEP_TIMEOUT_MS;
    const model = config.model;

    const modelIdOf = (m: LanguageModel) => (typeof m === "string" ? m : m.modelId);

    // Tag a terminal failure with the agent and model it came from, preserving the
    // original error as the cause so the known-error matcher can still read it.
    const fail = (err: unknown): never => {
        const msg = err instanceof Error ? err.message : String(err);
        throw new AgentError(`agent "${config.id}" (model ${modelIdOf(model)}) failed: ${msg}`, config.id, err);
    };

    const YELLOW = "\x1b[33m";
    const RESET = "\x1b[0m";

    for (let retry = 0; retry < MAX_RETRIES; retry++) {
        const heartbeat = () => {};
        const tools = typeof config.tools === "function" ? await config.tools(heartbeat) : config.tools;

        const agent = new ToolLoopAgent({
            model,
            maxRetries: AI_MAX_RETRIES,
            instructions: config.systemPrompt,
            tools,
            temperature: config.temperature,
            stopWhen: [stepCountIs(config.maxSteps), hasToolCall("finish")],
            onStepFinish: buildStepHandler(config),
        });

        try {
            const messages: ModelMessage[] = [{ role: "user", content: prompt }];
            let generation = await agent.generate({
                messages,
                timeout: { stepMs: stepTimeout },
            });

            let nudges = 0;
            while (extractResult() === undefined && nudges < MAX_NUDGES) {
                nudges++;
                console.log(
                    `  ${YELLOW}[${config.id}] agent stopped without finishing - nudging (${nudges}/${MAX_NUDGES})...${RESET}`,
                );
                track("cli_agent_nudged", { agent: config.id, nudge: nudges });
                messages.push(...generation.response.messages);
                messages.push({ role: "user", content: NUDGE_PROMPT });
                generation = await agent.generate({
                    messages,
                    timeout: { stepMs: stepTimeout },
                });
            }

            return extractResult();
        } catch (err) {
            const errorClass = classifyAgentError(err);

            if (errorClass === "fatal") fail(err);

            const msg = err instanceof Error ? err.message : String(err);
            if (errorClass === "timeout") {
                console.log(`  ${YELLOW}[${config.id}] step timed out after ${stepTimeout / 1000}s${RESET}`);
            } else {
                console.log(`  ${YELLOW}[${config.id}] provider error: ${msg}${RESET}`);
            }
            track("cli_agent_retryable_error", { agent: config.id, error_class: errorClass, retry });

            if (retry < MAX_RETRIES - 1) {
                console.log(`  ${YELLOW}[${config.id}] retrying (${retry + 1}/${MAX_RETRIES})...${RESET}`);
                if (errorClass === "transient") {
                    await sleep(Math.min(2000 * 2 ** retry, 10_000));
                }
                continue;
            }

            fail(err);
        }
    }

    return extractResult();
}
