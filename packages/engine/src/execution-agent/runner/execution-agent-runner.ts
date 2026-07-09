import { type Logger, logger } from "@autonoma/logger";
import type { CommandSpec } from "../../commands";
import type { BaseCommandContext, ImageStream, Installer, VideoRecorder } from "../../platform";
import type { ExecutionAgent, ExecutionAgentFactory, TestCase } from "../agent";
import type { ExecutionResult } from "../agent";
import type { RunnerEventHandlers } from "./events";

export interface ExecutionAgentRunnerConfig<
    TSpec extends CommandSpec,
    TApplicationData,
    TContext extends BaseCommandContext,
> {
    /** Installer for the context */
    installer: Installer<TApplicationData, TContext>;

    /** Execution agent factory for the agent */
    executionAgentFactory: ExecutionAgentFactory<TSpec, TContext>;

    /** Event handlers for the runner */
    eventHandlers: RunnerEventHandlers<TSpec>;
}

export interface HeadlessRunResult<TSpec extends CommandSpec = CommandSpec> {
    result: ExecutionResult<TSpec>;
    videoPath: string;
}

/**
 * The ExecutionAgentRunner is responsible for the entire execution process.
 *
 * In the future, we will add the ability to connect to the server via WebSocket.
 */
export class ExecutionAgentRunner<TSpec extends CommandSpec, TApplicationData, TContext extends BaseCommandContext> {
    protected readonly logger: Logger;

    protected agent: ExecutionAgent<TSpec, TContext> | null = null;
    protected prompt: string | null = null;
    protected videoRecorder: VideoRecorder | null = null;
    protected imageStream: ImageStream | null = null;
    protected testCase: (TestCase & TApplicationData) | null = null;
    protected context: TContext | null = null;

    constructor(protected readonly config: ExecutionAgentRunnerConfig<TSpec, TApplicationData, TContext>) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    // --------------------------------------------------------
    // Setup
    // --------------------------------------------------------

    /**
     * Set up the execution agent, using the installer and execution agent factory.
     */
    public async setupAgent(testCase: TestCase & TApplicationData, prompt: string): Promise<void> {
        this.logger.info("Starting execution agent setup...");

        this.prompt = prompt;
        this.testCase = testCase;

        const context = await this.buildContext(testCase);
        this.agent = await this.buildAgent(context);
        this.logger.info("Setup completed successfully");
    }

    /** Build the context for the execution agent */
    private async buildContext(applicationData: TApplicationData): Promise<TContext> {
        const {
            installer,
            eventHandlers: { frame: frameHandler },
        } = this.config;

        this.logger.info("Building context...");

        try {
            const { context, imageStream, videoRecorder } = await installer.install(applicationData);

            this.imageStream = imageStream;
            this.context = context;

            // Register a callback to emit the frames to event consumers
            this.imageStream.addFrameHandler(frameHandler);

            this.videoRecorder = videoRecorder;

            return context;
        } catch (error) {
            this.logger.fatal("Failed to build context", error);
            throw error;
        }
    }

    /** Build the execution agent */
    private async buildAgent(context: TContext): Promise<ExecutionAgent<TSpec, TContext>> {
        const {
            executionAgentFactory,
            eventHandlers: { beforeStep: beforeStepHandler, attempt: attemptHandler },
        } = this.config;
        this.logger.info("Building execution agent...");

        try {
            const agent = await executionAgentFactory.buildAgent({
                drivers: context,
                beforeCommand: async ({ agent }) => beforeStepHandler({ state: agent.getState() }),
                onAttempt: async ({ attempt, order, successfulOrder }) =>
                    attemptHandler({ attempt, order, successfulOrder }),
            });

            this.logger.info("Execution agent built successfully");
            return agent;
        } catch (error) {
            this.logger.fatal("Failed to build execution agent", error);
            throw error;
        }
    }

    // --------------------------------------------------------
    // Run
    // --------------------------------------------------------

    public getContext(): TContext | null {
        return this.context;
    }

    protected seedMemory(entries: Record<string, string>): void {
        if (this.agent == null) {
            throw new Error("Cannot seed memory before the agent is built");
        }
        const memory = this.agent.getMemory();
        for (const [key, value] of Object.entries(entries)) {
            memory.set(key, value);
        }
    }

    public async run(): Promise<HeadlessRunResult<TSpec>> {
        this.logger.info("Running execution agent...");
        if (this.agent == null || this.prompt == null || this.videoRecorder == null) {
            throw new Error("Execution agent not setup");
        }

        const agent = this.agent;
        const prompt = this.prompt;

        const result = await this.videoRecorder.withRecording(() => agent.generate(prompt));
        const videoPath = await this.videoRecorder.getVideoPath();

        const { success, finishReason, generatedSteps, conversation } = result;
        this.logger.info("Execution agent finished execution", {
            success,
            finishReason,
            stepCount: generatedSteps.length,
            messageCount: conversation.length,
        });

        return { result, videoPath };
    }
}
