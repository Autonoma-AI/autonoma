import type { CostCollector } from "@autonoma/ai";
import type { CommandSpec } from "../../commands";
import type { BaseCommandContext } from "../../platform";
import type { TestCase } from "../agent";
import { ExecutionAgentRunner, type ExecutionAgentRunnerConfig } from "../runner";
import type { GenerationPersister, PlanData } from "./generation-persister";

export interface GenerationAPIRunnerConfig<
    TSpec extends CommandSpec,
    TApplicationData,
    TContext extends BaseCommandContext,
> extends Omit<ExecutionAgentRunnerConfig<TSpec, TApplicationData, TContext>, "eventHandlers"> {
    /** Video extension for the artifacts */
    videoExtension: string;

    /** Generation persister */
    generationPersister: GenerationPersister<TSpec>;

    /** Cost collector for tracking AI costs */
    costCollector?: CostCollector;
}

export abstract class GenerationAPIRunner<
    TSpec extends CommandSpec,
    TContext extends BaseCommandContext,
    TApplicationData,
> extends ExecutionAgentRunner<TSpec, TApplicationData, TContext> {
    protected readonly persister: GenerationPersister<TSpec>;
    private readonly costCollector?: CostCollector;

    constructor(config: GenerationAPIRunnerConfig<TSpec, TApplicationData, TContext>) {
        super({
            ...config,
            eventHandlers: {
                frame: async () => {},
                beforeStep: async () => {},
                afterStep: async ({ state }) => {
                    // biome-ignore lint/style/noNonNullAssertion: A step was ran, so there is a last step
                    const lastStep = state.steps[state.steps.length - 1]!;
                    const stepData = lastStep.executionOutput.stepData;
                    await this.persister.recordStep(
                        {
                            interaction: stepData.interaction,
                            params: stepData.params,
                            output: lastStep.executionOutput.result,
                            beforeScreenshot: lastStep.beforeMetadata.screenshot,
                            afterScreenshot: lastStep.afterMetadata.screenshot,
                        },
                        state,
                    );
                },
            },
        });
        this.persister = config.generationPersister;
        this.costCollector = config.costCollector;
    }

    public abstract parsePlanData(planData: PlanData): Promise<TestCase & TApplicationData>;

    public async runGeneration(): Promise<void> {
        this.logger.info("Marking generation as running");
        const planData = await this.persister.markRunning();

        try {
            this.logger.info("Parsing plan data", { testPlan: planData.testPlan });
            const testCase = await this.parsePlanData(planData);
            this.logger.info("Test case parsed", { name: testCase.name, prompt: testCase.prompt });

            await this.setupAgent(testCase, testCase.prompt);

            if (testCase.credentials != null && Object.keys(testCase.credentials).length > 0) {
                this.logger.info("Seeding agent memory with scenario credentials", {
                    keys: Object.keys(testCase.credentials),
                });
                this.seedMemory(testCase.credentials);
            }

            const runResult = await this.run();

            this.logger.info("Generation finished", {
                success: runResult.result.success,
                reason: runResult.result.finishReason,
            });
            await this.persister.markCompleted(runResult);
            await this.persister.uploadConversation(runResult.result.conversation);

            if (this.costCollector != null) {
                await this.persister.saveCostRecords(this.costCollector.getRecords());
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : "Unknown error";
            await this.persister.markFailed(reason);
            throw error;
        }
    }
}
