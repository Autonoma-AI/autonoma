import { db } from "@autonoma/db";
import type { ObservabilityContext } from "@autonoma/logger";
import { loadSnapshotObservabilityContext } from "./load-snapshot-context";

/**
 * Given a domain Run id, derive the full observability context: snapshot,
 * branch, application, organization, plus the run group itself. Used by the
 * Temporal activity interceptor so that activities whose input only carries
 * `runId` (replay activities, review activities, ...) still emit logs that
 * carry snapshotId / branchId / applicationId / organizationId.
 *
 * Returns just the run group if the run doesn't exist (caller decides whether
 * that's an error). Never throws.
 */
export async function loadRunObservabilityContext(runId: string): Promise<ObservabilityContext> {
    const run = await db.run.findUnique({
        where: { id: runId },
        select: { assignment: { select: { snapshotId: true } } },
    });

    if (run == null) return { run: { runId } };

    const snapshotContext = await loadSnapshotObservabilityContext(run.assignment.snapshotId);
    return { ...snapshotContext, run: { runId } };
}
