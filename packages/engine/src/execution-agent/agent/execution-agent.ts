import { AI_REQUEST_TIMEOUT_MS, type LanguageModel, type VisualConditionChecker } from "@autonoma/ai";
import { external } from "@autonoma/errors";
import type { Screenshot } from "@autonoma/image";
import { type Logger, logger } from "@autonoma/logger";
import {
    type StepResult as AIStepResult,
    type ModelMessage,
    type TextPart,
    ToolLoopAgent,
    hasToolCall,
    stepCountIs,
} from "ai";
import type { CommandSpec, StepData } from "../../commands";
import type { BaseCommandContext } from "../../platform";
import type { WaitPlanner } from "./components/wait-planner";
import type { ExecutionResult, FailedStep, GeneratedStep, StepAttempt, StepMetadata } from "./execution-result";
import { MemoryStore } from "./memory";
import { type AskUserHandler, buildAskUserTool } from "./tools/ask-user-tool";
import type { AgentExecutionOutput, CommandFailure, CommandTool } from "./tools/command-tool";
import { type ExecutionFinishedOutput, buildExecutionFinishedTool } from "./tools/execution-finished-tool";
import { buildWaitTool } from "./tools/wait-tool";

export interface BeforeCommandArgs<TSpec extends CommandSpec, TContext extends BaseCommandContext> {
    agent: ExecutionAgent<TSpec, TContext>;
    context: TContext;
    interaction: TSpec["interaction"];
    input: unknown;
}

interface AfterCommandArgs<TSpec extends CommandSpec, TContext extends BaseCommandContext> {
    agent: ExecutionAgent<TSpec, TContext>;
    context: TContext;
    output: AgentExecutionOutput<TSpec>;
}

export interface OnAttemptArgs<TSpec extends CommandSpec, TContext extends BaseCommandContext> {
    agent: ExecutionAgent<TSpec, TContext>;

    /** The attempt that just happened (success or failure). */
    attempt: StepAttempt<TSpec>;

    /** 1-based position in the full attempt timeline (counts failures). */
    order: number;

    /** 1-based position in the successful-only replay list. Present only for successful attempts. */
    replayOrder?: number;
}

export interface ExecutionAgentRunParams<TSpec extends CommandSpec, TContext extends BaseCommandContext> {
    /** The drivers to use for execution */
    drivers: TContext;

    /** Callback for when the execution is finished */
    onFinish: (output: ExecutionResult<TSpec>) => Promise<void>;

    /** Callback for before a command is executed. */
    beforeCommand: (args: BeforeCommandArgs<TSpec, TContext>) => Promise<void>;

    /**
     * Callback fired once per command attempt - both successes and failures.
     * This is the single live persistence hook; consumers branch on
     * `attempt.status`.
     */
    onAttempt: (args: OnAttemptArgs<TSpec, TContext>) => Promise<void>;

    /** Metadata to record before the execution */
    beforeMetadata: (args: BeforeCommandArgs<TSpec, TContext>) => Promise<Record<string, unknown>>;

    /** Metadata to record after the execution finishes */
    afterMetadata: (args: AfterCommandArgs<TSpec, TContext>) => Promise<Record<string, unknown>>;
}

export interface ExecutionAgentConfig<TSpec extends CommandSpec, TContext extends BaseCommandContext> {
    /** The language model that will run the tool execution loop */
    model: LanguageModel;

    /** System prompt for the execution agent */
    systemPrompt: string;

    /** The maximum number of steps the agent will take */
    maxSteps: number;

    /** The list of command tools available to the agent */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commandTools: CommandTool<TSpec, TContext>[];

    /** Minimum time to wait between steps, in milliseconds */
    minTimeBetweenSteps: number;

    /** Maximum time to wait between steps, in milliseconds */
    maxTimeBetweenSteps: number;

    /** Wait planner */
    waitPlanner: WaitPlanner<TSpec>;

    /** Optional handler for asking the user questions (only available in frontend-connected sessions) */
    askUserHandler?: AskUserHandler;

    /**
     * When provided, each wait condition is validated against the step's
     * pre-screenshot in-flight during execution (as part of the step's
     * `waitConditionPromise`). Conditions that fail are replanned, and stripped
     * if replanning also fails, so they cannot cause false-negative timeouts
     * during replay.
     */
    waitConditionValidator?: VisualConditionChecker;
}

/** Internal representation of a successful step, carrying the still-pending wait condition. */
type InternalSuccessStep<TSpec extends CommandSpec> = Omit<GeneratedStep<TSpec>, "waitCondition"> & {
    waitConditionPromise: Promise<string | null>;
};

/** Internal representation of a single attempt in the full timeline. */
type InternalAttempt<TSpec extends CommandSpec> = InternalSuccessStep<TSpec> | FailedStep<TSpec>;

export interface ExecutionState<TSpec extends CommandSpec = CommandSpec> {
    /** The full attempt timeline, including failures. */
    attempts: StepAttempt<TSpec>[];
    conversation: ModelMessage[];
}

export class UnknownGenerationError extends Error {
    constructor(cause: Error) {
        super(`Unknown generation error: ${cause.message}`, { cause });
    }
}

export class InvalidStepError extends Error {
    constructor(public readonly step: Partial<InternalSuccessStep<CommandSpec>>) {
        super("There was an error generating an execution step. This is probably a bug in the execution agent.");
    }
}

export class ExecutionAgent<TSpec extends CommandSpec, TContext extends BaseCommandContext> {
    private readonly logger: Logger;

    private readonly agent: ReturnType<typeof this.buildAgent>;

    /** The full attempt timeline (successes and failures), in order. */
    private readonly attempts: InternalAttempt<TSpec>[] = [];
    public currentStep: Partial<InternalSuccessStep<TSpec>> = {};

    private stepResults: AIStepResult<ReturnType<typeof this.buildTools>>[] = [];

    private outputData: ExecutionFinishedOutput | null = null;

    private lastContextScreenshot: Screenshot | undefined = undefined;

    private currentInstruction: string | null = null;

    /** Memory store for extracted values that persist across steps */
    private readonly memory = new MemoryStore();

    constructor(
        private readonly params: ExecutionAgentConfig<TSpec, TContext> & ExecutionAgentRunParams<TSpec, TContext>,
    ) {
        this.logger = logger.child({ name: "ExecutionAgent" });
        this.agent = this.buildAgent();
    }

    public async stream(prompt: string) {
        this.currentInstruction = prompt;
        const messages = [{ role: "user" as const, content: prompt }];

        return external(() => this.agent.stream({ messages }), {
            wrapper: (error) => new UnknownGenerationError(error),
        });
    }

    public async generate(prompt: string): Promise<ExecutionResult<TSpec>> {
        this.currentInstruction = prompt;
        const messages = [{ role: "user" as const, content: prompt }];

        const generateResult = await external(() => this.agent.generate({ messages }), {
            wrapper: (error) => new UnknownGenerationError(error),
        });

        return this.buildExecutionResult(generateResult.steps);
    }

    /** Get the memory store for reading/writing extracted values. */
    public getMemory(): MemoryStore {
        return this.memory;
    }

    /** Get the current execution state. */
    public getState(): ExecutionState<TSpec> {
        return {
            attempts: this.attempts.map((attempt) => toPublicAttempt(attempt)),
            conversation: this.stepResults.flatMap((step) => step.response.messages),
        };
    }

    private buildAgent() {
        return new ToolLoopAgent({
            model: this.params.model,
            instructions: this.params.systemPrompt,
            timeout: AI_REQUEST_TIMEOUT_MS,
            prepareStep: async (step) => {
                this.stepResults = step.steps;

                const additionalContext = await this.getStepContext();

                return { ...step, messages: [...step.messages, ...additionalContext] };
            },
            onStepFinish: async ({ content }) => {
                const text = (content.filter(({ type }) => type === "text") as TextPart[])
                    .map(({ text }) => text)
                    .join("\n\n");

                this.logger.info("Step finished", { text });

                const startTime = Date.now();
                this.logger.debug("Waiting for page to stabilize...");

                await new Promise((resolve) => setTimeout(resolve, this.params.minTimeBetweenSteps));

                await this.params.drivers.application.waitUntilStable();

                this.logger.debug("Page stabilized", {
                    duration: Date.now() - startTime,
                });
            },
            onFinish: async ({ steps }) => this.params.onFinish?.(await this.buildExecutionResult(steps)),
            stopWhen: [stepCountIs(this.params.maxSteps), hasToolCall("execution-finished")],
            tools: this.buildTools(),
        });
    }

    private buildTools() {
        return {
            ...(Object.fromEntries(
                this.params.commandTools.map((commandTool) => [
                    commandTool.interaction,
                    commandTool.toTool({
                        getContext: () => this.getCommandContext(),
                        getMemory: () => this.memory,
                        beforeExecute: async (input, context) =>
                            this.beforeExecute(commandTool.interaction, input, context),
                        afterExecute: async (_input, output, context) => this.afterExecute(output, context),
                        onFailure: async (failure) => this.recordFailure(failure),
                    }),
                ]),
            ) as Record<string, unknown>),
            // Wait tool
            wait: buildWaitTool(),
            // Ask-user tool (only when a handler is provided, i.e. frontend-connected sessions)
            ...(this.params.askUserHandler != null ? { "ask-user": buildAskUserTool(this.params.askUserHandler) } : {}),
            // Execution finished tool
            "execution-finished": buildExecutionFinishedTool((finishOutput) => {
                const loopDetected =
                    !finishOutput.success &&
                    /(loop|stuck|no progress|repeating|repeated)/i.test(finishOutput.reasoning ?? "");
                this.logger.info("Execution finished", {
                    success: finishOutput.success,
                    finishReason: finishOutput.success ? "success" : "error",
                    loopDetected,
                    reasoning: finishOutput.reasoning,
                });

                this.outputData = finishOutput;
            }),
        } as const;
    }

    /** Additional context to send to the model before each step */
    protected async getStepContext(): Promise<ModelMessage[]> {
        const { screen } = this.params.drivers;

        this.logger.info("Getting step context...");

        const screenshot = await screen.screenshot();

        this.lastContextScreenshot = screenshot;

        // Start the current step
        this.currentStep = { status: "success", beforeMetadata: { screenshot } };

        if (this.currentInstruction == null) {
            throw new Error("Execution requires an instruction");
        }
        const instruction = this.currentInstruction;
        // Include failed attempts so the model can see its own botched attempts inline.
        const stepsSoFar = this.attempts.map((attempt, index) => summarizeAttempt(attempt, index + 1));
        const memoryEntries = this.memory.getAll();
        const memorySection =
            Object.keys(memoryEntries).length > 0
                ? ["", "Stored variables (memory):", JSON.stringify(memoryEntries, null, 2)]
                : [];

        const dialogSection = this.buildDialogSection();

        const reminder =
            "IMPORTANT: Review the steps above. If you are repeating the same or similar actions and the page state is not changing (no tangible progress towards the goal), STOP and call execution-finished with success: false. Briefly explain which repeated actions indicate a loop.";
        const contextText = [
            "Instruction:",
            instruction,
            "",
            "Steps executed so far (oldest to newest):",
            JSON.stringify(stepsSoFar, null, 2),
            ...memorySection,
            ...dialogSection,
            "",
            reminder,
        ].join("\n");

        return [
            {
                role: "user",
                content: [
                    { type: "image", image: screenshot.base64 },
                    { type: "text", text: contextText },
                ],
            },
        ];
    }

    /**
     * Builds the context lines describing native browser dialogs (alert / confirm / prompt)
     * that appeared since the previous step. These are browser chrome, not DOM, so they never
     * show up in the screenshot - the agent only learns about them here. Empty when the platform
     * has no dialog observer or no dialogs fired.
     */
    private buildDialogSection(): string[] {
        const dialogs = this.params.drivers.dialogs?.takePending() ?? [];
        if (dialogs.length === 0) return [];

        this.logger.info("Including native dialogs in step context", { extra: { count: dialogs.length } });

        const summarized = dialogs.map((dialog) => ({
            type: dialog.type,
            message: dialog.message,
            outcome: dialog.outcome,
            promptValue: dialog.promptValue,
        }));

        return [
            "",
            "Native browser dialogs appeared since the previous step and were handled automatically. " +
                "These are browser chrome, NOT part of the page DOM or the screenshot - this is the only place you can see them:",
            JSON.stringify(summarized, null, 2),
            "An accepted dialog means the action behind it (e.g. a delete/save confirmation) has already proceeded - continue from that result rather than looking for an OK button on the page.",
        ];
    }

    /** Context for command execution */
    protected getCommandContext(): TContext {
        return this.params.drivers;
    }

    /** Called before a command is executed */
    protected async beforeExecute(interaction: TSpec["interaction"], input: unknown, context: TContext): Promise<void> {
        this.logger.info("Command step started", { command: interaction, input });

        await this.params.beforeCommand({ agent: this, interaction, input, context });

        const metadata = await this.params.beforeMetadata({
            agent: this,
            interaction,
            input,
            context,
        });

        this.currentStep.beforeMetadata = {
            ...this.currentStep.beforeMetadata,
            ...metadata,
        } as StepMetadata;
    }

    /** Called after a command is executed */
    protected async afterExecute(output: AgentExecutionOutput<TSpec>, context: TContext): Promise<void> {
        this.logger.info("Command step finished", output);

        const screenshot = await context.screen.screenshot();

        const metadata = await this.params.afterMetadata({
            agent: this,
            output,
            context,
        });

        this.currentStep.afterMetadata = {
            ...this.currentStep.afterMetadata,
            ...metadata,
            screenshot,
        } as StepMetadata;
        if (this.currentStep.beforeMetadata == null) this.logger.fatal("Missing before step screenshot");

        this.currentStep.executionOutput = output;

        // Write to memory if the command returned a value with a variable name
        const stepParams = output.stepData.params as unknown as Record<string, unknown>;
        const stepResult = output.result as unknown as Record<string, unknown>;
        if (typeof stepParams.variableName === "string" && typeof stepResult.value === "string") {
            this.memory.set(stepParams.variableName as string, stepResult.value as string);
            this.logger.info("Stored value in memory", {
                variableName: stepParams.variableName,
                value: stepResult.value,
            });
        }

        // Plan a wait if needed. The "previous step" for wait planning is the last
        // *successful* step - failed attempts never get a wait condition.
        const lastStepData = this.lastSuccessfulStep();
        const beforeScreenshot = this.currentStep.beforeMetadata?.screenshot ?? screenshot;
        const waitConditionPromise = this.planWaitCondition(lastStepData, output.stepData, beforeScreenshot);

        this.logger.info("Saving generated step", this.currentStep.executionOutput.stepData);
        const step = this.pushStep({ ...this.currentStep, waitConditionPromise });

        await this.params.onAttempt({
            agent: this,
            attempt: toPublicAttempt(step),
            order: this.attempts.length,
            replayOrder: this.successfulCount(),
        });
    }

    /**
     * Records a failed command attempt. Failed attempts never get a wait
     * condition and never touch the memory store - a thrown command has no
     * result. A best-effort after-screenshot is captured (absent if even that fails).
     */
    private async recordFailure(failure: CommandFailure<TSpec>): Promise<void> {
        this.logger.warn("Recording failed command attempt", {
            interaction: failure.interaction,
            error: failure.error.message,
            errorName: failure.error.constructor.name,
        });

        const beforeMetadata = this.currentStep.beforeMetadata;
        if (beforeMetadata == null) {
            this.logger.fatal("Missing before screenshot for failed attempt");
            throw new InvalidStepError(this.currentStep);
        }

        const afterMetadata = await this.captureFailureAfterMetadata();

        const failedStep: FailedStep<TSpec> = {
            status: "failed",
            interaction: failure.interaction,
            input: failure.input,
            params: failure.params,
            error: failure.error.message,
            errorName: failure.error.constructor.name,
            beforeMetadata,
            afterMetadata,
        };

        this.attempts.push(failedStep);

        await this.params.onAttempt({
            agent: this,
            attempt: failedStep,
            order: this.attempts.length,
        });
    }

    /** Best-effort after-screenshot for a failed attempt; absent if the capture itself fails. */
    private async captureFailureAfterMetadata(): Promise<StepMetadata | undefined> {
        try {
            const screenshot = await this.params.drivers.screen.screenshot();
            return { screenshot };
        } catch (error) {
            this.logger.warn("Failed to capture after-screenshot for failed attempt", { error });
            return undefined;
        }
    }

    /** The most recent successful step, used as the reference for wait planning. */
    private lastSuccessfulStep(): InternalSuccessStep<TSpec> | undefined {
        for (let i = this.attempts.length - 1; i >= 0; i--) {
            const attempt = this.attempts[i];
            if (attempt?.status === "success") return attempt;
        }
        return undefined;
    }

    /** Number of successful attempts recorded so far. */
    private successfulCount(): number {
        return this.attempts.filter((attempt) => attempt.status === "success").length;
    }

    /** Validates and adds a successful step to the attempt timeline, returning it. */
    private pushStep(agentStep: Partial<InternalSuccessStep<TSpec>>): InternalSuccessStep<TSpec> {
        const { beforeMetadata, afterMetadata, waitConditionPromise, executionOutput } = agentStep;

        if (beforeMetadata == null) {
            this.logger.fatal("Missing before step screenshot");
            throw new InvalidStepError(agentStep);
        }

        if (afterMetadata == null) {
            this.logger.fatal("Missing after step screenshot");
            throw new InvalidStepError(agentStep);
        }

        if (waitConditionPromise == null) {
            this.logger.fatal("Missing wait condition");
            throw new InvalidStepError(agentStep);
        }

        if (executionOutput == null) {
            this.logger.fatal("Missing step");
            throw new InvalidStepError(agentStep);
        }

        const step: InternalSuccessStep<TSpec> = {
            status: "success",
            executionOutput,
            beforeMetadata,
            afterMetadata,
            waitConditionPromise,
        };
        this.attempts.push(step);
        return step;
    }

    /**
     * Plans the wait condition for a step and, when a validator is configured,
     * validates it against the step's pre-screenshot - replanning or stripping
     * conditions that don't match the UI. This runs as part of the in-flight
     * `waitConditionPromise` (created in `afterExecute`) so validation is spread
     * across execution rather than bursting at the end of the generation.
     */
    private async planWaitCondition(
        prevStep: InternalSuccessStep<TSpec> | undefined,
        newStepData: StepData<TSpec>,
        beforeScreenshot: Screenshot,
    ): Promise<string | null> {
        const condition =
            prevStep == null
                ? this.params.waitPlanner.planFirstWait(newStepData)
                : await this.params.waitPlanner.planWait({
                      prevStep: prevStep.executionOutput.stepData,
                      prevScreenshot: prevStep.afterMetadata.screenshot,
                      newStep: newStepData,
                      newScreenshot: beforeScreenshot,
                  });

        const validator = this.params.waitConditionValidator;
        if (condition == null || validator == null) return condition;

        try {
            const check = await validator.checkCondition(condition, beforeScreenshot);
            if (check.metCondition) return condition;

            this.logger.warn("Wait condition failed against generation screenshot, replanning", {
                interaction: newStepData.interaction,
                waitCondition: condition,
                reason: check.reason,
            });

            if (prevStep == null) {
                this.logger.warn("No previous step available for replanning, stripping condition", {
                    interaction: newStepData.interaction,
                });
                return null;
            }
            return await this.replanWaitCondition(prevStep, newStepData, beforeScreenshot, condition, check.reason);
        } catch (err) {
            this.logger.warn("Wait condition validation failed, keeping as-is", {
                interaction: newStepData.interaction,
                err,
            });
            return condition;
        }
    }

    private async replanWaitCondition(
        prevStep: InternalSuccessStep<TSpec>,
        newStepData: StepData<TSpec>,
        beforeScreenshot: Screenshot,
        failedCondition: string,
        failureReason: string,
    ): Promise<string | null> {
        try {
            const replanned = await this.params.waitPlanner.replanWait({
                prevStep: prevStep.executionOutput.stepData,
                prevScreenshot: prevStep.afterMetadata.screenshot,
                newStep: newStepData,
                newScreenshot: beforeScreenshot,
                failedCondition,
                failureReason,
            });
            this.logger.info("Wait condition replanned", {
                interaction: newStepData.interaction,
                replanned,
            });
            return replanned;
        } catch (err) {
            this.logger.warn("Wait condition replan failed, stripping", {
                interaction: newStepData.interaction,
                err,
            });
            return null;
        }
    }

    private async buildExecutionResult(
        steps: AIStepResult<ReturnType<typeof this.buildTools>>[],
    ): Promise<ExecutionResult<TSpec>> {
        // The replay subset is derived by filtering the full timeline to successes.
        const successfulSteps = this.attempts.filter(
            (attempt): attempt is InternalSuccessStep<TSpec> => attempt.status === "success",
        );
        const generatedSteps: GeneratedStep<TSpec>[] = await Promise.all(
            successfulSteps.map(async ({ waitConditionPromise, ...agentStep }) => {
                let waitCondition: string | null | undefined;
                try {
                    waitCondition = await waitConditionPromise;
                } catch (error) {
                    this.logger.fatal("Failed to generate wait condition for step", {
                        interaction: agentStep.executionOutput.stepData.interaction,
                        error,
                    });
                }

                return {
                    ...agentStep,
                    waitCondition: waitCondition ?? undefined,
                };
            }),
        );

        let success = this.outputData?.success ?? false;
        const reasoning = this.outputData?.reasoning ?? "Execution stopped unexpectedly";

        if (success) {
            const hasAnyCommandSteps = generatedSteps.length > 0;
            const hasAssertStep = generatedSteps.some(
                (step) => String(step.executionOutput.stepData.interaction) === "assert",
            );
            if (!hasAnyCommandSteps || !hasAssertStep) {
                success = false;
            }
        }

        const finishReason =
            this.outputData != null
                ? success
                    ? ("success" as const)
                    : ("error" as const)
                : steps.length >= this.params.maxSteps
                  ? ("max_steps" as const)
                  : ("error" as const);

        return {
            generatedSteps,
            memory: this.memory.getAll(),
            finishReason,
            success,
            reasoning,
            finalScreenshot: this.lastContextScreenshot,
            conversation: this.stepResults.flatMap((step) => step.response.messages),
        };
    }
}

/** Strips the internal wait-condition promise from a successful step, leaving the public shape. */
function toPublicAttempt<TSpec extends CommandSpec>(attempt: InternalAttempt<TSpec>): StepAttempt<TSpec> {
    if (attempt.status === "failed") return attempt;
    const { waitConditionPromise: _waitConditionPromise, ...step } = attempt;
    return step;
}

/** Builds the compact, model-facing summary of an attempt for the "steps so far" context. */
function summarizeAttempt<TSpec extends CommandSpec>(attempt: InternalAttempt<TSpec>, order: number) {
    if (attempt.status === "failed") {
        return {
            order,
            status: "failed" as const,
            interaction: attempt.interaction,
            params: attempt.params,
            error: attempt.error,
        };
    }

    return {
        order,
        status: "success" as const,
        interaction: attempt.executionOutput.stepData.interaction,
        params: attempt.executionOutput.stepData.params,
        outcome: attempt.executionOutput.result.outcome,
    };
}
