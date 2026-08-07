import type { Prisma } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

const logger = rootLogger.child({ name: "forkScenarioDataForSnapshot" });

/**
 * Everything tying a row to the snapshot it belonged to; the read returns the descriptive columns, which the
 * fork carries over verbatim. A new column that points into the snapshot must be added here, or the fork would
 * copy the source's value - leaving it out of the read is what makes the create fail to typecheck until the
 * fork supplies the target's.
 */
const SCHEMA_SNAPSHOT_IDENTITY = { id: true, snapshotId: true, createdAt: true } as const;
const RECIPE_VERSION_IDENTITY = {
    id: true,
    snapshotId: true,
    schemaSnapshotId: true,
    createdAt: true,
    updatedAt: true,
} as const;

export interface ForkScenarioDataParams {
    tx: Prisma.TransactionClient;
    sourceSnapshotId: string;
    targetSnapshotId: string;
}

/**
 * Deep-copy a snapshot's scenario data onto a newly created snapshot: the schema snapshots and the recipe
 * versions that freeze the suite's scenario shape at that point in a branch's lineage.
 *
 * Runs inside the caller's transaction, which holds the branch lock, so every write is batched: a per-row
 * create loop here stalls every other opener on the branch.
 */
export async function forkScenarioDataForSnapshot({
    tx,
    sourceSnapshotId,
    targetSnapshotId,
}: ForkScenarioDataParams): Promise<void> {
    const schemaSnapshots = await tx.scenarioSchemaSnapshot.findMany({
        where: { snapshotId: sourceSnapshotId },
        omit: SCHEMA_SNAPSHOT_IDENTITY,
    });
    if (schemaSnapshots.length === 0) return;

    // (applicationId, snapshotId) is unique, so applicationId correlates each created row back to the source row
    // it copies - which is what lets this be one batched insert instead of a per-row create loop.
    const forked = await tx.scenarioSchemaSnapshot.createManyAndReturn({
        data: schemaSnapshots.map((schemaSnapshot) => ({ ...schemaSnapshot, snapshotId: targetSnapshotId })),
        select: { id: true, applicationId: true },
    });
    const forkedSchemaIdByApplicationId = new Map(forked.map((row) => [row.applicationId, row.id]));

    const recipeVersions = await tx.scenarioRecipeVersion.findMany({
        where: { snapshotId: sourceSnapshotId },
        omit: RECIPE_VERSION_IDENTITY,
    });
    if (recipeVersions.length === 0) return;

    logger.info("Forking scenario data onto the new snapshot", {
        extra: {
            sourceSnapshotId,
            targetSnapshotId,
            schemaSnapshotCount: schemaSnapshots.length,
            recipeVersionCount: recipeVersions.length,
        },
    });
    await tx.scenarioRecipeVersion.createMany({
        data: recipeVersions.map((recipeVersion) => ({
            ...recipeVersion,
            snapshotId: targetSnapshotId,
            schemaSnapshotId: forkedSchemaSnapshotId(recipeVersion.applicationId),
        })),
    });

    function forkedSchemaSnapshotId(applicationId: string): string {
        const id = forkedSchemaIdByApplicationId.get(applicationId);
        if (id == null) {
            throw new Error(`Snapshot ${sourceSnapshotId} has no scenario schema snapshot for ${applicationId}`);
        }
        return id;
    }
}
