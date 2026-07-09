import { logger, type Logger } from "@autonoma/logger";
import {
    stepCountIs,
    ToolLoopAgent,
    type ModelMessage,
    type PrepareStepFunction,
    type StepResult,
    type StopCondition,
    type Tool,
    wrapLanguageModel,
} from "ai";
import type { MessageCompactor } from "../compaction/types";
import type { LanguageModel } from "../registry/model-registry";
import { DEFAULT_RETRY_CONFIG } from "../retry";
import { createRetryMiddleware } from "../retry-middleware";
import { logStepContent } from "./log-step";
import type { ReportResultTool } from "./tools/agent-result";
import type { AgentTool } from "./tools/agent-tool";
import { FatalToolError } from "./tools/tool-errors";

type GenericToolSet = Record<string, Tool>;
type PrepareStepArgs = Parameters<PrepareStepFunction<GenericToolSet>>[0];
type PrepareStepReturn = Awaited<ReturnType<PrepareStepFunction<GenericToolSet>>>;
type AgentStepResult = StepResult<GenericToolSet>;

/**
 * Default step cap applied when {@link AgentConfig.maxSteps} is not provided. Deliberately large:
 * forcing `toolChoice: "required"` removes the loop's natural text-finish stop, so this acts purely
 * as a runaway backstop, not a tuning knob - well above any healthy run's real step count.
 */
export const DEFAULT_MAX_STEPS = 1000;

export interface AgentConfig<TResult> {
    /** A descriptive name for this type of agent, used for observability. */
    name: string;

    /** The model to use for the agent loop. */
    model: LanguageModel;

    /**
     * Maximum number of steps the agent will take before failing with {@link MaxStepsReached}.
     * Defaults to {@link DEFAULT_MAX_STEPS}. Because the loop forces a structured tool call on
     * every step (`toolChoice: "required"`), the model can never end its turn with plain text;
     * this cap is the loop's only other stop besides the report tool firing, so it is always set.
     */
    maxSteps?: number;

    /**
     * The system prompt of the agent.
     *
     * Must be set when constructing the agent, not at the start of the generation. This precludes
     * the system prompt from carrying dynamic per-run information, which is an intended design
     * restriction: anything that varies by run belongs in the user prompt.
     */
    systemPrompt: string;

    /** The tool used to report the result of the agent execution. */
    reportTool: ReportResultTool<unknown, TResult>;

    /** Tools that may be used during the execution of the agent loop. */
    tools: AgentTool<unknown, unknown>[];

    /**
     * Optional message-compaction configuration. When set, the loop calls `strategy.compact`
     * before each step whose previous step's reported input-token count meets or exceeds
     * `threshold`; the strategy's output replaces the messages sent to the model. The raw,
     * uncompacted message stream produced by the agent is what {@link AgentLoop.runLoop}
     * returns - compaction only affects what's sent to the model, never what's persisted.
     */
    compactor?: {
        strategy: MessageCompactor;
        /** Token budget for the previous step's input before the strategy runs. */
        threshold: number;
    };
}

export class NoAgentResultError extends FatalToolError {
    constructor(
        public readonly conversation: ModelMessage[],
        public readonly partialResult?: unknown,
    ) {
        super("No result was produced by the agent loop");
    }
}

export class MaxStepsReached extends FatalToolError {
    constructor(
        public readonly conversation: ModelMessage[],
        public readonly partialResult?: unknown,
    ) {
        super("The agent loop reached the maximum number of steps without producing a result");
    }
}

export class MultipleResultCalls extends FatalToolError {
    constructor() {
        super("The result tool was called multiple times during the agent loop execution, which is not allowed");
    }
}

/** What {@link AgentLoop.runLoop} (and therefore {@link Agent.run}) returns. */
export interface AgentRunResult<TResult> {
    result: TResult;
    /** Every message the model emitted during the run: text, tool calls, tool results. */
    conversation: ModelMessage[];
}

/**
 * Per-run state holder for an agent.
 *
 * Keeps track of the {@link ToolLoopAgent} instance and the loop's accumulated result. Subclass to
 * carry additional per-run state - validation context, partial collectors, snapshot of state for
 * the report tool to read.
 */
export class AgentLoop<TResult = unknown> {
    protected readonly logger: Logger;

    protected result: TResult | undefined = undefined;

    private readonly name: string;
    private readonly model: LanguageModel;
    private readonly systemPrompt: string;
    private readonly tools: AgentTool<unknown, unknown>[];
    private readonly resultTool: ReportResultTool<unknown, TResult>;
    private readonly maxSteps: number;
    private readonly compactor: { strategy: MessageCompactor; threshold: number } | undefined;

    constructor({
        name,
        model,
        systemPrompt,
        tools,
        reportTool: resultTool,
        maxSteps,
        compactor,
    }: AgentConfig<TResult>) {
        this.name = name;
        this.model = model;
        this.systemPrompt = systemPrompt;
        this.tools = tools;
        this.resultTool = resultTool;
        this.maxSteps = maxSteps ?? DEFAULT_MAX_STEPS;
        this.compactor = compactor;

        this.logger = logger.child({ name: this.name });
    }

    /** Set the result of the execution. Called by {@link ReportResultTool.execute}. */
    public setResult(result: TResult) {
        if (this.result != null) {
            this.logger.fatal("Result tool was called multiple times during agent loop execution", {
                previousResult: this.result,
                newResult: result,
            });
            throw new MultipleResultCalls();
        }

        this.logger.info("Setting result of agent loop", { result });
        this.result = result;
    }

    /**
     * Hook invoked before each step. Subclasses can override to inject per-step messages or
     * settings. Default implementation is identity (returns the input args unchanged).
     */
    protected async prepareStep(args: PrepareStepArgs): Promise<PrepareStepReturn> {
        return args;
    }

    /**
     * Hook invoked after each step finishes. The default logs the step's content via
     * {@link logStepContent} - subclasses can override or chain (`super.onStepFinish(result)`)
     * to add custom per-step side effects.
     */
    protected async onStepFinish(result: AgentStepResult): Promise<void> {
        logStepContent(this.logger, result.content);
    }

    /**
     * Optional hook subclasses can implement to expose a partial result when the loop terminates
     * without the report tool firing (e.g. max-steps reached, agent gave up). The returned value
     * is attached to {@link NoAgentResultError.partialResult} / {@link MaxStepsReached.partialResult}
     * so callers can persist partial state for debugging.
     */
    protected snapshotPartial?(): unknown;

    /**
     * Custom stop condition that fires once the report tool has produced a result.
     */
    private readonly hasProducedResult: StopCondition<GenericToolSet> = () => this.result !== undefined;

    public async runLoop(userPrompt: ModelMessage[]): Promise<AgentRunResult<TResult>> {
        this.logger.info("Starting agent loop", { tools: this.tools.map((t) => t.name) });

        const tools: GenericToolSet = Object.fromEntries(
            [...this.tools, this.resultTool].map((t) => [t.name, t.toTool(this)]),
        );

        const agent = new ToolLoopAgent({
            // Retry transient provider failures (rate limits, 5xx, dropped connections) with capped
            // exponential backoff via middleware, and disable the AI SDK's own retry (`maxRetries: 0`)
            // so the two layers don't compound. The SDK default of 2 retries surfaced as AI_RetryError
            // on brief provider blips; the middleware retries the raw model call per step, so a single
            // flaky step no longer aborts the whole run and tool calls are never replayed.
            model: wrapLanguageModel({ model: this.model, middleware: createRetryMiddleware(DEFAULT_RETRY_CONFIG) }),
            maxRetries: 0,
            instructions: this.systemPrompt,
            tools,
            // Force a structured tool call on every step. Without this the AI SDK stops the loop as
            // soon as a step returns finishReason !== "tool-calls" (e.g. the model writes its result
            // as prose, ends with an empty turn, or types a tool call as text), which surfaced as
            // NoAgentResultError. "required" keeps finishReason at "tool-calls" until the report tool
            // sets the result and trips hasProducedResult.
            toolChoice: "required",
            stopWhen: [this.hasProducedResult, stepCountIs(this.maxSteps)],
            prepareStep: async (args) =>
                applyCompactor(await this.prepareStep(args), args, this.compactor, this.logger),
            onStepFinish: (result) => this.onStepFinish(result),
        });

        const generationResult = await agent.generate({ messages: userPrompt });
        const conversation = generationResult.response.messages;

        if (this.result === undefined) {
            const partialResult = this.snapshotPartial?.();
            if (generationResult.steps.length >= this.maxSteps) {
                this.logger.fatal("Agent loop reached maximum number of steps without producing a result");
                throw new MaxStepsReached(conversation, partialResult);
            }
            this.logger.fatal("Agent loop finished without producing a result");
            throw new NoAgentResultError(conversation, partialResult);
        }

        this.logger.info("Agent loop finished successfully", { result: this.result });

        return { result: this.result, conversation };
    }
}

async function applyCompactor(
    innerResult: PrepareStepReturn,
    args: PrepareStepArgs,
    compactor: { strategy: MessageCompactor; threshold: number } | undefined,
    logger: Logger,
): Promise<PrepareStepReturn> {
    if (compactor == null) return innerResult;

    const previousStepInputTokens = args.steps.at(-1)?.usage?.inputTokens ?? 0;
    const tripped = previousStepInputTokens >= compactor.threshold;
    logger.info("Compaction gate evaluated", {
        extra: { threshold: compactor.threshold, previousStepInputTokens, tripped },
    });
    if (!tripped) return innerResult;

    const messages = innerResult?.messages ?? args.messages;
    try {
        const compacted = await compactor.strategy.compact(messages);
        if (compacted.messagesAffected === 0) return innerResult;

        logger.info("Compaction strategy applied", {
            compaction: { strategy: compactor.strategy.name, messagesAffected: compacted.messagesAffected },
        });
        return { ...innerResult, messages: compacted.messages };
    } catch (error) {
        // Compaction is a safety net, not load-bearing for correctness: a strategy bug should not
        // take down a step that might otherwise succeed. Log and continue with uncompacted messages.
        logger.error(
            "Compaction strategy threw - continuing with uncompacted messages",
            error instanceof Error ? error : new Error(String(error)),
            { compaction: { strategy: compactor.strategy.name } },
        );
        return innerResult;
    }
}
