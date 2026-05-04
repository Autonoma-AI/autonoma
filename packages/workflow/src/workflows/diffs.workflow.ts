import { executeChild, proxyActivities } from "@temporalio/workflow";
import type { DiffsActivities } from "../activities";
import { TaskQueue } from "../task-queues";
import type { WorkflowArchitecture } from "../types";
import { WORKFLOW_TYPE } from "./workflow-types";

const longRunning = proxyActivities<DiffsActivities>({
    startToCloseTimeout: "30m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

const standard = proxyActivities<DiffsActivities>({
    startToCloseTimeout: "15m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

const shortLived = proxyActivities<DiffsActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

export interface DiffsAnalysisInput {
    snapshotId: string;
}

interface RunReplayArgs {
    runId: string;
    architecture: WorkflowArchitecture;
    scenarioId?: string;
}

function dispatchReplay({ runId, architecture, scenarioId }: RunReplayArgs): Promise<void> {
    return executeChild(WORKFLOW_TYPE.RUN_REPLAY, {
        workflowId: `run-replay-${runId}`,
        taskQueue: TaskQueue.GENERAL,
        args: [{ runId, architecture, scenarioId, skipIssueBugCreation: true }],
    });
}

interface GenerationArgs {
    testGenerationId: string;
    scenarioId?: string;
    architecture: WorkflowArchitecture;
}

function dispatchGeneration({ testGenerationId, scenarioId, architecture }: GenerationArgs): Promise<void> {
    return executeChild(WORKFLOW_TYPE.SINGLE_GENERATION, {
        workflowId: `generation-${testGenerationId}`,
        taskQueue: TaskQueue.GENERAL,
        args: [{ testGenerationId, scenarioId, architecture, skipIssueBugCreation: true }],
    });
}

export async function diffsAnalysisWorkflow(input: DiffsAnalysisInput): Promise<void> {
    const { snapshotId } = input;

    // Step 1: Analyze diffs - explores code, updates skills, identifies affected tests, suggests new tests
    const step1 = await longRunning.analyzeDiffs({ snapshotId });

    // Step 2: Execute affected test replays in parallel.
    // The replay-reviewer fires automatically in each replay workflow's finally block,
    // populating RunReview records (but skipping Issue/Bug creation for diffs replays).
    if (step1.preparedRuns.length > 0) {
        await Promise.allSettled(step1.preparedRuns.map((run) => dispatchReplay(run)));
    }

    // Step 3: Resolve - reads reviewer verdicts, modifies stale tests, gathers pending generations
    const runIds = step1.preparedRuns.map((r) => r.runId);
    const step2 = await standard.resolveDiffs({
        snapshotId,
        runIds,
        step1Reasoning: step1.reasoning,
        testCandidates: step1.testCandidates,
        affectedTests: step1.affectedTests,
    });

    // Step 4: Execute generations in parallel.
    // The generation-reviewer fires automatically in each generation workflow's finally block
    // (skipping Issue/Bug creation for diffs-triggered generations).
    if (step2.generations.length > 0) {
        await Promise.allSettled(step2.generations.map((gen) => dispatchGeneration(gen)));
    }

    // Step 5: Finalize - assigns generation results, activates snapshot
    const generationIds = step2.generations.map((g) => g.testGenerationId);
    await shortLived.finalizeDiffs({ snapshotId, generationIds });
}
