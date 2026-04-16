import type { CommandSpec } from "../../commands";
import type { BaseCommandContext } from "../../platform";
import type { ExecutionResult } from "../agent";
import { ArtifactWriter, ExecutionAgentRunner, type ExecutionAgentRunnerConfig, getRunDirectory } from "../runner";
import { loadTestCase } from "./load-test-case";

export interface LocalRunnerConfig<
    TSpec extends CommandSpec,
    TApplicationData,
    TContext extends BaseCommandContext,
> extends ExecutionAgentRunnerConfig<TSpec, TApplicationData, TContext> {
    /** Video extension for the artifacts */
    videoExtension: string;
    /** Override the artifact output directory. When omitted, falls back to ARTIFACT_DIR env or default timestamped directory. */
    artifactDir?: string;
}

export class LocalRunner<
    TSpec extends CommandSpec,
    TApplicationData,
    TContext extends BaseCommandContext,
> extends ExecutionAgentRunner<TSpec, TApplicationData, TContext> {
    private readonly videoExtension: string;
    private readonly artifactDir?: string;

    constructor({ videoExtension, artifactDir, ...config }: LocalRunnerConfig<TSpec, TApplicationData, TContext>) {
        super(config);
        this.videoExtension = videoExtension;
        this.artifactDir = artifactDir;
    }

    /**
     * Executes a test case defined locally and saves artifacts to disk.
     *
     * Returns the execution result so callers can inspect success/failure,
     * steps, and reasoning without re-parsing the saved artifacts.
     */
    public async runLocalExecution(testCasePath: string): Promise<ExecutionResult<TSpec>> {
        this.logger.info("Loading test case", { testCasePath });
        const testCase = await loadTestCase(testCasePath, this.config.installer.paramsSchema);
        this.logger.info("Test case loaded", { testCase: testCase.name });

        await this.setupAgent(testCase, testCase.prompt);

        const { result: executionResult, videoPath } = await this.run();

        const runDirectory = this.artifactDir ?? getRunDirectory(testCase.name);
        this.logger.info("Saving artifacts", { directory: runDirectory });

        new ArtifactWriter(runDirectory, {
            videoExtension: this.videoExtension,
        }).saveAll({
            executionResult,
            instruction: testCase.prompt,
            videoPath,
        });

        this.logger.info("Artifacts saved");

        return executionResult;
    }
}
