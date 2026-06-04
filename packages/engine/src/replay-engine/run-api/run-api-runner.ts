import { type Logger, logger } from "@autonoma/logger";
import type { CommandSpec } from "../../commands";
import type { BaseCommandContext } from "../../platform";
import type { ReplayStep } from "../engine/replay-step";
import { ReplayRunner, type ReplayRunnerConfig } from "../runner/replay-runner";
import type { RunData, RunPersister } from "./run-persister";

export interface RunAPIRunnerConfig<
    TSpec extends CommandSpec,
    TApplicationData,
    TContext extends BaseCommandContext,
> extends Omit<ReplayRunnerConfig<TSpec, TApplicationData, TContext>, "eventHandlers"> {
    videoExtension: string;
    runPersister: RunPersister<TSpec>;
}

export abstract class RunAPIRunner<
    TSpec extends CommandSpec,
    TContext extends BaseCommandContext,
    TApplicationData,
> extends ReplayRunner<TSpec, TApplicationData, TContext> {
    protected readonly persister: RunPersister<TSpec>;
    protected readonly runnerLogger: Logger;

    constructor(config: RunAPIRunnerConfig<TSpec, TApplicationData, TContext>) {
        const runnerLogger = logger.child({ name: "RunAPIRunner" });

        super({
            ...config,
            eventHandlers: {
                frame: async () => {},
                beforeStep: async ({ step }) => {
                    runnerLogger.info("Executing step", {
                        stepIndex: step.index,
                        interaction: step.stepData.interaction,
                        params: step.stepData.params,
                        hasWaitCondition: step.waitCondition != null,
                    });
                },
                afterStep: async ({ step, result }) => {
                    runnerLogger.info("Persisting step result", {
                        stepIndex: step.index,
                        interaction: step.stepData.interaction,
                        params: step.stepData.params,
                        status: result.status,
                    });
                    await config.runPersister.recordStep(
                        {
                            interaction: step.stepData.interaction,
                            params: step.stepData.params,
                            output: result.status === "passed" ? result.output : undefined,
                            error: result.status === "failed" ? result.error : undefined,
                            beforeScreenshot: result.screenshotBefore,
                            afterScreenshot: result.screenshotAfter,
                        },
                        step.index + 1,
                    );
                },
            },
        });
        this.persister = config.runPersister;
        this.runnerLogger = runnerLogger;
    }

    public abstract parseRunData(data: RunData): Promise<TApplicationData>;

    public async runReplay(): Promise<void> {
        this.runnerLogger.info("Marking run as running");
        const data = await this.persister.markRunning();

        try {
            this.runnerLogger.info("Parsing run data", { runId: data.run.id });
            const applicationData = await this.parseRunData(data);

            const steps = this.mapToReplaySteps(data.steps);
            this.runnerLogger.info("Steps mapped for replay", { stepCount: steps.length });

            await this.setup(applicationData);

            const runResult = await this.run(steps);

            this.runnerLogger.info("Replay finished", {
                success: runResult.result.success,
                stepCount: runResult.result.state.executedSteps.length,
            });

            await this.persister.markCompleted(runResult);
        } catch (error) {
            this.runnerLogger.error("Replay failed, marking run as failed", error);
            await this.persister.markFailed();
            throw error;
        }
    }

    private mapToReplaySteps(steps: RunData["steps"]): ReplayStep<TSpec>[] {
        return steps.map((step, index) => ({
            index,
            stepData: {
                interaction: step.interaction,
                params: step.params,
            } as ReplayStep<TSpec>["stepData"],
            waitCondition: step.waitCondition ?? undefined,
        }));
    }
}
