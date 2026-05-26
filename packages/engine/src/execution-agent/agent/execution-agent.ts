import { AI_REQUEST_TIMEOUT_MS, type LanguageModel } from "@autonoma/ai";
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
import type { CommandSpec } from "../../commands";
import type { BaseCommandContext } from "../../platform";
import type { WaitPlanner } from "./components/wait-planner";
import type { ExecutionResult, GeneratedStep } from "./execution-result";
import { MemoryStore } from "./memory";
import { type AskUserHandler, buildAskUserTool } from "./tools/ask-user-tool";
import type { AgentExecutionOutput, CommandTool } from "./tools/command-tool";
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

export interface ExecutionAgentRunParams<TSpec extends CommandSpec, TContext extends BaseCommandContext> {
    /** The drivers to use for execution */
    drivers: TContext;

    /** Callback for when the execution is finished */
    onFinish: (output: ExecutionResult<TSpec>) => Promise<void>;

    /** Callback for before a command is executed. */
    beforeCommand: (args: BeforeCommandArgs<TSpec, TContext>) => Promise<void>;

    /** Callback for after a command is executed. */
    afterCommand: (args: AfterCommandArgs<TSpec, TContext>) => Promise<void>;

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
}

/** Internal step type */
type InternalAgentStep<TSpec extends CommandSpec> = Omit<GeneratedStep<TSpec>, "waitCondition"> & {
    waitConditionPromise: Promise<string | null>;
};

export interface ExecutionState<TSpec extends CommandSpec = CommandSpec> {
    steps: GeneratedStep<TSpec>[];
    conversation: ModelMessage[];
}

export class UnknownGenerationError extends Error {
    constructor(cause: Error) {
        super(`Unknown generation error: ${cause.message}`, { cause });
    }
}

export class InvalidStepError extends Error {
    constructor(public readonly step: Partial<InternalAgentStep<CommandSpec>>) {
        super("There was an error generating an execution step. This is probably a bug in the execution agent.");
    }
}

export class ExecutionAgent<TSpec extends CommandSpec, TContext extends BaseCommandContext> {
    private readonly logger: Logger;

    private readonly agent: ReturnType<typeof this.buildAgent>;

    private readonly generatedSteps: InternalAgentStep<TSpec>[] = [];
    public currentStep: Partial<InternalAgentStep<TSpec>> = {};

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
    public getState() {
        return {
            // Omit the wait condition promise, it's an internal detail that should not be exposed to the client
            steps: this.generatedSteps.map(({ waitConditionPromise: _waitConditionPromise, ...step }) => step),
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
        this.currentStep = { beforeMetadata: { screenshot } } as Partial<InternalAgentStep<TSpec>>;

        if (this.currentInstruction == null) {
            throw new Error("Execution requires an instruction");
        }
        const instruction = this.currentInstruction;
        const stepsSoFar = this.generatedSteps.map((agentStep, index) => ({
            order: index + 1,
            interaction: agentStep.executionOutput.stepData.interaction,
            params: agentStep.executionOutput.stepData.params,
            outcome: agentStep.executionOutput.result.outcome,
        }));
        const memoryEntries = this.memory.getAll();
        const memorySection =
            Object.keys(memoryEntries).length > 0
                ? ["", "Stored variables (memory):", JSON.stringify(memoryEntries, null, 2)]
                : [];

        const reminder =
            "IMPORTANT: Review the steps above. If you are repeating the same or similar actions and the page state is not changing (no tangible progress towards the goal), STOP and call execution-finished with success: false. Briefly explain which repeated actions indicate a loop.";
        const contextText = [
            "Instruction:",
            instruction,
            "",
            "Steps executed so far (oldest to newest):",
            JSON.stringify(stepsSoFar, null, 2),
            ...memorySection,
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
        } as InternalAgentStep<TSpec>["beforeMetadata"];
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
        } as InternalAgentStep<TSpec>["afterMetadata"];
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

        // Plan a wait if needed
        const lastStepData = this.generatedSteps[this.generatedSteps.length - 1];
        const waitConditionPromise: Promise<string | null> =
            lastStepData == null
                ? Promise.resolve(this.params.waitPlanner.planFirstWait(output.stepData))
                : this.params.waitPlanner.planWait({
                      prevStep: lastStepData.executionOutput.stepData,
                      prevScreenshot: lastStepData.afterMetadata.screenshot,
                      newStep: output.stepData,
                      newScreenshot: this.currentStep.beforeMetadata?.screenshot ?? screenshot,
                  });

        this.logger.info("Saving generated step", this.currentStep.executionOutput.stepData);
        this.pushStep({ ...this.currentStep, waitConditionPromise });

        await this.params.afterCommand({
            agent: this,
            context,
            output,
        });
    }

    /** Validates and adds a step to the generated steps */
    private pushStep(agentStep: Partial<InternalAgentStep<TSpec>>): void {
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

        this.generatedSteps.push({
            executionOutput,
            beforeMetadata,
            afterMetadata,
            waitConditionPromise,
        } as InternalAgentStep<TSpec>);
    }

    private async buildExecutionResult(
        steps: AIStepResult<ReturnType<typeof this.buildTools>>[],
    ): Promise<ExecutionResult<TSpec>> {
        const generatedSteps = await Promise.all(
            this.generatedSteps.map(async (agentStep) => {
                let waitCondition: string | null | undefined;
                try {
                    waitCondition = await agentStep.waitConditionPromise;
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
