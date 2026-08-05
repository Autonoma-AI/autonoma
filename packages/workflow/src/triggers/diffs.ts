import { logger } from "@autonoma/logger";
import { getTemporalClient } from "../client";
import type { WorkflowRef } from "../types";

/**
 * Nothing starts a diffs workflow any more - a PR run is always an analysis run. What remains is the read path
 * behind a snapshot's Temporal link, for the pre-cutover runs still in the database.
 */
export async function findLatestWorkflowBySnapshotId(snapshotId: string): Promise<WorkflowRef | undefined> {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(`diffs-analysis-${snapshotId}`);

    try {
        const description = await handle.describe();
        return {
            workflowId: description.workflowId,
            runId: description.runId,
        };
    } catch (error) {
        logger.warn("Failed to query diffs workflow", {
            snapshot: { snapshotId },
            extra: { error: String(error) },
        });
        return undefined;
    }
}
