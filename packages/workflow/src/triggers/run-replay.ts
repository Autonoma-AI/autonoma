import { logger } from "@autonoma/logger";
import { Architecture } from "@autonoma/types";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { getWorkflowSearchAttributes } from "../search-attributes";
import { TaskQueue } from "../task-queues";
import type { WorkflowArchitecture, WorkflowRef } from "../types";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

export interface TriggerRunWorkflowParams {
    runId: string;
    architecture: Architecture;
    scenarioId?: string;
    urlOverride?: string;
    sdkUrlOverride?: string;
}

function toReplayArchitecture(architecture: Architecture): WorkflowArchitecture {
    switch (architecture) {
        case Architecture.web:
            return "WEB";
        case Architecture.ios:
            return "IOS";
        case Architecture.android:
            return "ANDROID";
    }
}

export async function triggerRunWorkflow(params: TriggerRunWorkflowParams): Promise<void> {
    const { runId, architecture, scenarioId, urlOverride, sdkUrlOverride } = params;

    logger.info("Triggering run replay workflow", { runId, architecture, scenarioId });

    const client = await getTemporalClient();
    const workflowId = `run-replay-${runId}`;

    await client.workflow.start(WORKFLOW_TYPE.RUN_REPLAY, {
        workflowId,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
        taskQueue: TaskQueue.GENERAL,
        searchAttributes: getWorkflowSearchAttributes(),
        args: [
            {
                runId,
                architecture: toReplayArchitecture(architecture),
                scenarioId,
                urlOverride,
                sdkUrlOverride,
            },
        ],
    });

    logger.info("Run replay workflow started", { workflowId, runId });
}

export async function findLatestWorkflowByRunId(runId: string): Promise<WorkflowRef | undefined> {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(`run-replay-${runId}`);

    try {
        const description = await handle.describe();
        return {
            workflowId: description.workflowId,
            runId: description.runId,
        };
    } catch (error) {
        logger.warn("Failed to query workflow", { runId, error });
        return undefined;
    }
}
