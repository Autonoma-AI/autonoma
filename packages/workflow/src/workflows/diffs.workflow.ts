import { executeChild, proxyActivities } from "@temporalio/workflow";
import type { GeneralActivities } from "../activities";
import { TaskQueue } from "../task-queues";
import { runReplayWorkflow } from "./run-replay.workflow";
import { singleGenerationWorkflow } from "./single-generation.workflow";

const longRunning = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "30m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 2 },
    taskQueue: TaskQueue.GENERAL,
});

const standard = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "15m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 2 },
    taskQueue: TaskQueue.GENERAL,
});

const shortLived = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 2 },
    taskQueue: TaskQueue.GENERAL,
});

export interface DiffsAnalysisInput {
    branchId: string;
}

export async function diffsAnalysisWorkflow(input: DiffsAnalysisInput): Promise<void> {
    const { branchId } = input;

    // Step 1: Analyze diffs - explores code, updates skills, identifies affected tests, suggests new tests
    const step1 = await longRunning.analyzeDiffs({ branchId });

    // Step 2: Execute affected test replays in parallel.
    // The replay-reviewer fires automatically in each replay workflow's finally block,
    // populating RunReview records (but skipping Issue/Bug creation for diffs replays).
    if (step1.preparedRuns.length > 0) {
        await Promise.allSettled(
            step1.preparedRuns.map((run) =>
                executeChild(runReplayWorkflow, {
                    workflowId: `run-replay-${run.runId}`,
                    args: [
                        {
                            runId: run.runId,
                            architecture: run.architecture,
                            scenarioId: run.scenarioId,
                            skipIssueBugCreation: true,
                        },
                    ],
                }),
            ),
        );
    }

    // Step 3: Resolve - reads reviewer verdicts, modifies stale tests, gathers pending generations
    const runIds = step1.preparedRuns.map((r) => r.runId);
    const step2 = await standard.resolveDiffs({
        branchId,
        runIds,
        step1Reasoning: step1.reasoning,
        testCandidates: step1.testCandidates,
        affectedTests: step1.affectedTests,
    });

    // Step 4: Execute generations in parallel.
    // The generation-reviewer fires automatically in each generation workflow's finally block
    // (skipping Issue/Bug creation for diffs-triggered generations).
    if (step2.generations.length > 0) {
        await Promise.allSettled(
            step2.generations.map((gen) =>
                executeChild(singleGenerationWorkflow, {
                    workflowId: `generation-${gen.testGenerationId}`,
                    args: [
                        {
                            testGenerationId: gen.testGenerationId,
                            scenarioId: gen.scenarioId,
                            architecture: gen.architecture,
                            skipIssueBugCreation: true,
                        },
                    ],
                }),
            ),
        );
    }

    // Step 5: Finalize - assigns generation results, activates snapshot
    const generationIds = step2.generations.map((g) => g.testGenerationId);
    await shortLived.finalizeDiffs({ branchId, generationIds });
}
