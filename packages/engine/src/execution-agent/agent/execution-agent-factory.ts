import { setScreenshotConfig } from "@autonoma/image";
import { type Logger, logger } from "@autonoma/logger";
import type { CommandSpec } from "../../commands";
import type { BaseCommandContext } from "../../platform";
import {
    type BeforeCommandArgs,
    ExecutionAgent,
    type ExecutionAgentConfig,
    type ExecutionAgentRunParams,
} from "./execution-agent";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./system-prompt";
import type { AskUserHandler } from "./tools/ask-user-tool";

/** The parameters that are optional for the ExecutionAgent. */
type ExecutionAgentOptionalParams =
    | "maxSteps"
    | "systemPrompt"
    | "minTimeBetweenSteps"
    | "maxTimeBetweenSteps"
    | "askUserHandler";

/**
 * The configuration for the execution agent factory. These are the same as
 * {@link ExecutionAgentConfig}, but with some optional parameters.
 */
export interface ExecutionAgentFactoryConfig<TSpec extends CommandSpec, TContext extends BaseCommandContext>
    extends
        Omit<ExecutionAgentConfig<TSpec, TContext>, ExecutionAgentOptionalParams>,
        Partial<Pick<ExecutionAgentConfig<TSpec, TContext>, ExecutionAgentOptionalParams>> {
    /** The platform architecture, used for screenshot configuration. */
    architecture: "web" | "mobile";

    /** Optional callback to inject platform-specific metadata before each command. */
    platformMetadata?: (args: BeforeCommandArgs<TSpec, TContext>) => Promise<Record<string, unknown>>;
}

type ExecutionAgentOptionalRunParams =
    | "onFinish"
    | "beforeCommand"
    | "afterCommand"
    | "beforeMetadata"
    | "afterMetadata";

export interface BuildAgentRunParams<TSpec extends CommandSpec, TContext extends BaseCommandContext>
    extends
        Omit<ExecutionAgentRunParams<TSpec, TContext>, ExecutionAgentOptionalRunParams>,
        Partial<Pick<ExecutionAgentRunParams<TSpec, TContext>, ExecutionAgentOptionalRunParams>> {
    /** Optional handler for asking the user questions (only in frontend-connected sessions) */
    askUserHandler?: AskUserHandler;
}

/**
 * The execution agent factory is responsible for building the execution agent.
 *
 * It offers a clear separation between the "static" parameters, that can be configured
 * during the configuration stage, and the "runtime" parameters, that are passed when running the agent.
 */
export class ExecutionAgentFactory<TSpec extends CommandSpec, TContext extends BaseCommandContext> {
    protected readonly logger: Logger;

    constructor(protected readonly params: ExecutionAgentFactoryConfig<TSpec, TContext>) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    /**
     * Build the actual execution agent.
     */
    async buildAgent(runParams: BuildAgentRunParams<TSpec, TContext>): Promise<ExecutionAgent<TSpec, TContext>> {
        this.logger.info("Building execution agent");

        const { screen } = runParams.drivers;

        this.logger.info("Setting screen resolution");
        const screenResolution = await screen.getResolution();

        setScreenshotConfig({ screenResolution, architecture: this.params.architecture });

        const { architecture: _architecture, platformMetadata, ...agentParams } = this.params;

        const composedBeforeMetadata = this.composeBeforeMetadata(runParams.beforeMetadata, platformMetadata);

        return new ExecutionAgent({
            onFinish: async () => {},
            beforeCommand: async () => {},
            afterCommand: async () => {},
            afterMetadata: async () => ({}),
            ...runParams,
            beforeMetadata: composedBeforeMetadata,
            maxSteps: 50,
            minTimeBetweenSteps: 1000,
            maxTimeBetweenSteps: 5000,
            systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
            ...agentParams,
            // askUserHandler comes from runParams (set at runtime by QuaraConnectionHandler)
            // and must not be overridden by factory config, so it's placed after the spread
            askUserHandler: runParams.askUserHandler,
        });
    }

    /**
     * Compose the caller's beforeMetadata with the factory's platformMetadata.
     * Platform metadata is merged on top of the caller's metadata.
     */
    private composeBeforeMetadata(
        callerMetadata: BuildAgentRunParams<TSpec, TContext>["beforeMetadata"],
        platformMetadata: ExecutionAgentFactoryConfig<TSpec, TContext>["platformMetadata"],
    ): (args: BeforeCommandArgs<TSpec, TContext>) => Promise<Record<string, unknown>> {
        if (platformMetadata == null) {
            return callerMetadata ?? (async () => ({}));
        }

        return async (args) => {
            const base = await (callerMetadata?.(args) ?? Promise.resolve({}));
            const platform = await platformMetadata(args);
            return { ...base, ...platform };
        };
    }
}
