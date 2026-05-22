import { db } from "@autonoma/db";
import type { ObservabilityContext } from "@autonoma/logger";
import { loadSnapshotObservabilityContext } from "./load-snapshot-context";

/**
 * Given a TestGeneration id, derive the full observability context: snapshot
 * + branch + application + organization, plus the testGeneration group.
 * Used by the Temporal activity interceptor so generation-scoped activities
 * automatically carry the broader chain of IDs in every log.
 *
 * Returns just the testGeneration group if the row doesn't exist. Never throws.
 */
export async function loadGenerationObservabilityContext(testGenerationId: string): Promise<ObservabilityContext> {
    const generation = await db.testGeneration.findUnique({
        where: { id: testGenerationId },
        select: { snapshotId: true },
    });

    if (generation == null) return { testGeneration: { testGenerationId } };

    const snapshotContext = await loadSnapshotObservabilityContext(generation.snapshotId);
    return { ...snapshotContext, testGeneration: { testGenerationId } };
}
