import { log, proxyActivities } from "@temporalio/workflow";
import type { GeneralActivities, MobileActivities, WebActivities } from "../activities";
import { TaskQueue } from "../task-queues";
import type { WorkflowArchitecture } from "../types";

const scenario = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 3 },
    taskQueue: TaskQueue.GENERAL,
});

const general = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.GENERAL,
});

export interface SingleGenerationInput {
    testGenerationId: string;
    scenarioId?: string;
    architecture: WorkflowArchitecture;
    skipIssueBugCreation?: boolean;
}

export async function singleGenerationWorkflow(input: SingleGenerationInput): Promise<void> {
    const { testGenerationId, scenarioId, architecture } = input;

    let scenarioInstanceId: string | undefined;

    if (scenarioId != null) {
        log.info("Starting scenario setup", { testGenerationId, scenarioId });
        try {
            const scenarioUpResult = await scenario.scenarioUp({
                scenarioJobType: "generation",
                entityId: testGenerationId,
                scenarioId,
            });
            scenarioInstanceId = scenarioUpResult.scenarioInstanceId;
            log.info("Scenario setup complete", { testGenerationId, scenarioInstanceId });
        } catch (error) {
            const reason = error instanceof Error ? error.message : "Scenario setup failed";
            log.error("Scenario setup failed", { testGenerationId, scenarioId, reason });
            await general.markGenerationFailed({
                testGenerationId,
                reason: `Scenario setup failed: ${reason}`,
            });
            throw error;
        }
    } else {
        log.warn("Scenario setup skipped: test plan has no linked scenario", { testGenerationId });
    }

    try {
        await runExecution(architecture, testGenerationId);
    } catch (error) {
        const reason = error instanceof Error ? error.message : "Execution failed";
        log.error("Generation execution failed, marking as failed", { testGenerationId, reason });
        await general.markGenerationFailed({ testGenerationId, reason });
        throw error;
    } finally {
        const postSteps: Promise<unknown>[] = [
            general.notifyGenerationExit({ testGenerationId }),
            reviewAndCreateIssue(testGenerationId, input.skipIssueBugCreation),
        ];

        if (scenarioInstanceId != null) {
            postSteps.push(scenario.scenarioDown({ scenarioInstanceId }));
        }

        await Promise.allSettled(postSteps);
    }
}

/**
 * Run the reviewer (always - success or failure), then chain the transitional
 * issue creator if the verdict warrants one. Sequential because the issue
 * creator consumes the verdict produced by the review.
 */
async function reviewAndCreateIssue(generationId: string, skipBugCreation?: boolean): Promise<void> {
    const reviewOutput = await general.reviewGeneration({ generationId });
    if (reviewOutput.status !== "completed" || reviewOutput.verdict == null) return;
    if (reviewOutput.verdict.verdict === "success") return;
    await general.createIssueFromGenerationReview({
        generationId,
        verdict: reviewOutput.verdict,
        skipBugCreation,
    });
}

async function runExecution(architecture: WorkflowArchitecture, testGenerationId: string): Promise<void> {
    if (architecture === "WEB") {
        const { runWebGeneration } = proxyActivities<WebActivities>({
            startToCloseTimeout: "90m",
            taskQueue: TaskQueue.WEB,
            heartbeatTimeout: "2m",
            retry: { maximumAttempts: 1 },
        });
        await runWebGeneration({ testGenerationId });
    } else {
        const { runMobileGeneration } = proxyActivities<MobileActivities>({
            startToCloseTimeout: "90m",
            taskQueue: TaskQueue.MOBILE,
            heartbeatTimeout: "2m",
            retry: { maximumAttempts: 1 },
        });
        await runMobileGeneration({ testGenerationId });
    }
}
