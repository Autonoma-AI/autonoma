import type { Prisma, PrismaClient } from "@autonoma/db";
import { type ScenarioRecipe, type ScenarioStructureJson, ScenarioStructureJsonSchema } from "@autonoma/types";

/** Which recipe version a write targeted: the scenario's active version, or the main branch's pending snapshot. */
export type RecipeUpdateTarget = "active" | "pending";

/** The active recipe version + its schema snapshot - enough to retarget the pending snapshot's version. */
export interface RecipeUpdateActiveVersion {
    id: string;
    snapshotId: string;
    schemaSnapshot: { structureJson: unknown; fingerprint: string };
}

export interface ApplyScenarioRecipeUpdateParams {
    scenario: {
        id: string;
        applicationId: string;
        organizationId: string;
        activeRecipeVersion: RecipeUpdateActiveVersion;
    };
    /** The full new recipe to store (name/description/create/variables/validation). */
    recipe: ScenarioRecipe;
    /** SHA-256 over the recipe payload (the caller computes it so the fingerprint stays a single definition). */
    fingerprint: string;
    /** The main branch's pending snapshot id, if any - the update propagates to it so the next deploy carries it. */
    pendingSnapshotId?: string;
    /** Whether the fingerprint changed (stamps `fingerprintChangedAt` for discovery). */
    fingerprintChanged: boolean;
}

export interface ApplyScenarioRecipeUpdateResult {
    updatedRecipeVersions: Array<{ id: string; snapshotId: string; target: RecipeUpdateTarget }>;
}

/**
 * Apply a recipe update atomically: overwrite the scenario's ACTIVE recipe version, propagate the same recipe to
 * the main branch's PENDING snapshot version (so the next deploy carries it), and stamp the scenario's
 * description + fingerprint. This is the single write path for recipe edits - the API's `updateRecipe` (UI) and
 * the investigation agent's autofix both call it, so the mutation logic never diverges.
 *
 * The caller owns loading + validating the scenario and computing the fingerprint; this function only performs
 * the transactional write.
 */
export async function applyScenarioRecipeUpdate(
    db: PrismaClient,
    params: ApplyScenarioRecipeUpdateParams,
): Promise<ApplyScenarioRecipeUpdateResult> {
    const { scenario, recipe, fingerprint, pendingSnapshotId, fingerprintChanged } = params;
    const activeRecipeVersion = scenario.activeRecipeVersion;
    const shouldUpdatePending = pendingSnapshotId != null && pendingSnapshotId !== activeRecipeVersion.snapshotId;

    const updatedRecipeVersions = await db.$transaction(async (tx) => {
        const updated: Array<{ id: string; snapshotId: string; target: RecipeUpdateTarget }> = [];

        const activeRecipe = await tx.scenarioRecipeVersion.update({
            where: { id: activeRecipeVersion.id },
            data: buildRecipeVersionUpdateData(recipe, fingerprint),
            select: { id: true, snapshotId: true },
        });
        updated.push({ ...activeRecipe, target: "active" });

        if (shouldUpdatePending) {
            const pendingRecipe = await upsertPendingRecipeVersion({
                tx,
                scenario,
                pendingSnapshotId,
                recipe,
                fingerprint,
            });
            updated.push({ ...pendingRecipe, target: "pending" });
        }

        await tx.scenario.update({
            where: { id: scenario.id },
            data: {
                description: recipe.description,
                lastSeenFingerprint: fingerprint,
                ...(fingerprintChanged ? { fingerprintChangedAt: new Date() } : {}),
            },
        });

        return updated;
    });

    return { updatedRecipeVersions };
}

/** The recipe-version columns to (re)write from a recipe + fingerprint. */
function buildRecipeVersionUpdateData(recipe: ScenarioRecipe, fingerprint: string) {
    return {
        scenarioNameSnapshot: recipe.name,
        description: recipe.description,
        fingerprint,
        validationStatus: recipe.validation.status,
        validationMethod: recipe.validation.method,
        validationPhase: recipe.validation.phase,
        validationUpMs: recipe.validation.up_ms ?? null,
        validationDownMs: recipe.validation.down_ms ?? null,
        fixtureJson: recipe,
    };
}

/** Upsert the recipe version for the pending snapshot, carrying the active version's schema snapshot forward. */
async function upsertPendingRecipeVersion(params: {
    tx: Prisma.TransactionClient;
    scenario: ApplyScenarioRecipeUpdateParams["scenario"];
    pendingSnapshotId: string;
    recipe: ScenarioRecipe;
    fingerprint: string;
}) {
    const { tx, scenario, pendingSnapshotId, recipe, fingerprint } = params;
    const schema = scenario.activeRecipeVersion.schemaSnapshot;

    const schemaSnapshot = await tx.scenarioSchemaSnapshot.upsert({
        where: { applicationId_snapshotId: { applicationId: scenario.applicationId, snapshotId: pendingSnapshotId } },
        create: {
            applicationId: scenario.applicationId,
            snapshotId: pendingSnapshotId,
            structureJson: toStructureJson(schema.structureJson),
            fingerprint: schema.fingerprint,
        },
        update: {
            structureJson: toStructureJson(schema.structureJson),
            fingerprint: schema.fingerprint,
        },
        select: { id: true },
    });

    return tx.scenarioRecipeVersion.upsert({
        where: { scenarioId_snapshotId: { scenarioId: scenario.id, snapshotId: pendingSnapshotId } },
        create: {
            scenarioId: scenario.id,
            snapshotId: pendingSnapshotId,
            schemaSnapshotId: schemaSnapshot.id,
            applicationId: scenario.applicationId,
            organizationId: scenario.organizationId,
            ...buildRecipeVersionUpdateData(recipe, fingerprint),
        },
        update: {
            schemaSnapshotId: schemaSnapshot.id,
            ...buildRecipeVersionUpdateData(recipe, fingerprint),
        },
        select: { id: true, snapshotId: true },
    });
}

/** The active version's stored structureJson is opaque here; validate it at the boundary into the typed shape. */
function toStructureJson(structureJson: unknown): ScenarioStructureJson {
    return ScenarioStructureJsonSchema.parse(structureJson);
}
