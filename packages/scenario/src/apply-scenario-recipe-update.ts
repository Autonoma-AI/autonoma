import type { Prisma, PrismaClient, ScenarioRecipeEditSource } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { type ScenarioRecipe, type ScenarioStructureJson, ScenarioStructureJsonSchema } from "@autonoma/types";

/**
 * Which recipe version a write targeted: the scenario's active-pointer version, or the snapshot on main's active /
 * pending pointer.
 */
export type RecipeUpdateTarget = "active" | "main-active" | "main-pending";

/** The active recipe version + its schema snapshot - enough to seed a version on a snapshot that lacks one. */
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
    /** Whether the fingerprint changed (stamps `fingerprintChangedAt` for discovery). */
    fingerprintChanged: boolean;
    /** Who is writing. Recorded on the history row so the change stays attributable afterwards. */
    source: ScenarioRecipeEditSource;
    /** The user who drove the write, when there was one. */
    actorUserId?: string;
    /** Optional human-readable reason, e.g. an agent's description of what it changed. */
    note?: string;
}

export interface ApplyScenarioRecipeUpdateResult {
    updatedRecipeVersions: Array<{ id: string; snapshotId: string; target: RecipeUpdateTarget }>;
}

/**
 * Apply a recipe update atomically: overwrite the scenario's active-pointer version and propagate the same recipe
 * to main's active and pending snapshot. This is the single write path for recipe edits - the API's `updateRecipe`
 * (UI) and the investigation agent's autofix both call it, so the mutation logic never diverges.
 *
 * Writing main's snapshots is what makes the edit reach production: recipe versions are keyed by
 * `(scenarioId, snapshotId)` and the provisioning path looks a version up by the run's snapshot, never by the
 * active pointer. Snapshots are cloned per PR and per deploy, so an edit written only to the pointer's snapshot
 * lands on whichever snapshot the app was onboarded on and is invisible to every subsequent run.
 *
 * Main is deliberately the ONLY branch written. A feature branch's snapshot is the recipe its runs were evaluated
 * against, so rewriting it under an in-flight PR would silently change what those results mean; a new branch picks
 * up the current recipe by forking from main (see `resolveSnapshotSource`). The corollary is that an ALREADY-OPEN
 * PR never receives a recipe fix - not even on a push, which forks from the branch's own active snapshot.
 * Investigation twins and merge proposals are excluded for the same reason, and are additionally DETACHED
 * snapshots (see `createDetachedSnapshot`) whose candidate recipes must not be clobbered.
 *
 * The caller owns loading + validating the scenario and computing the fingerprint; this function only performs
 * the transactional write.
 */
export async function applyScenarioRecipeUpdate(
    db: PrismaClient,
    params: ApplyScenarioRecipeUpdateParams,
): Promise<ApplyScenarioRecipeUpdateResult> {
    const { scenario, recipe, fingerprint, fingerprintChanged, source, actorUserId, note } = params;
    const activeRecipeVersion = scenario.activeRecipeVersion;
    const logger = rootLogger.child({ name: "applyScenarioRecipeUpdate" });

    const { pointerSnapshots, mainActiveSnapshotId } = await resolveRecipePropagation(db, scenario.applicationId);
    logger.info("Applying recipe update", {
        application: { applicationId: scenario.applicationId },
        extra: {
            scenarioId: scenario.id,
            fingerprint,
            activeSnapshotId: activeRecipeVersion.snapshotId,
            mainActiveSnapshotId,
            pointerSnapshotCount: pointerSnapshots.length,
        },
    });

    const updatedRecipeVersions = await db.$transaction(async (tx) => {
        const updated: Array<{ id: string; snapshotId: string; target: RecipeUpdateTarget }> = [];

        const activeRecipe = await tx.scenarioRecipeVersion.update({
            where: { id: activeRecipeVersion.id },
            data: buildRecipeVersionUpdateData(recipe, fingerprint),
            select: { id: true, snapshotId: true },
        });
        updated.push({ ...activeRecipe, target: "active" });

        for (const pointer of pointerSnapshots) {
            if (pointer.snapshotId === activeRecipeVersion.snapshotId) continue;
            const version = await upsertRecipeVersionForSnapshot({
                tx,
                scenario,
                snapshotId: pointer.snapshotId,
                recipe,
                fingerprint,
            });
            updated.push({ ...version, target: pointer.target });
        }

        // Follow the pointer to main's live snapshot. Left alone it stays on whatever snapshot the app was
        // onboarded on, which goes `superseded` on the first deploy - so reads (`getRecipe` reads the pointer)
        // and runs (which read by snapshot) would keep drifting apart after every edit.
        const mainActiveVersionId = updated.find((version) => version.snapshotId === mainActiveSnapshotId)?.id;

        await tx.scenario.update({
            where: { id: scenario.id },
            data: {
                description: recipe.description,
                lastSeenFingerprint: fingerprint,
                fingerprintChangedAt: fingerprintChanged ? new Date() : undefined,
                activeRecipeVersionId: mainActiveVersionId,
            },
        });

        // In the same transaction as the write it records: the version row is overwritten in
        // place, so if this row is not written atomically with it the previous recipe is gone
        // and there is nothing to attribute or restore.
        await tx.scenarioRecipeEdit.create({
            data: {
                scenarioId: scenario.id,
                applicationId: scenario.applicationId,
                organizationId: scenario.organizationId,
                recipeVersionId: activeRecipeVersion.id,
                snapshotId: activeRecipeVersion.snapshotId,
                fingerprint,
                fixtureJson: recipe,
                source,
                actorUserId,
                note,
            },
        });

        return updated;
    });

    logger.info("Recipe update applied", {
        application: { applicationId: scenario.applicationId },
        extra: { scenarioId: scenario.id, updatedRecipeVersions },
    });
    return { updatedRecipeVersions };
}

interface RecipePropagation {
    /** Main's pointer snapshots, in write order. Empty when the application has no main branch or no snapshot yet. */
    pointerSnapshots: Array<{ snapshotId: string; target: RecipeUpdateTarget }>;
    /** Main's active snapshot, where the scenario's active pointer belongs. Absent when main has no snapshot yet. */
    mainActiveSnapshotId?: string;
}

/** Resolve the snapshots a recipe edit must reach: main's active snapshot, and its pending one when a deploy is mid-flight. */
async function resolveRecipePropagation(db: PrismaClient, applicationId: string): Promise<RecipePropagation> {
    const application = await db.application.findUnique({
        where: { id: applicationId },
        select: { mainBranch: { select: { activeSnapshotId: true, pendingSnapshotId: true } } },
    });
    const mainBranch = application?.mainBranch;
    if (mainBranch == null) return { pointerSnapshots: [] };

    const pointerSnapshots: Array<{ snapshotId: string; target: RecipeUpdateTarget }> = [];
    if (mainBranch.activeSnapshotId != null) {
        pointerSnapshots.push({ snapshotId: mainBranch.activeSnapshotId, target: "main-active" });
    }
    if (mainBranch.pendingSnapshotId != null) {
        pointerSnapshots.push({ snapshotId: mainBranch.pendingSnapshotId, target: "main-pending" });
    }

    return { pointerSnapshots, mainActiveSnapshotId: mainBranch.activeSnapshotId ?? undefined };
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

/** Upsert the recipe version for one snapshot, carrying the active version's schema snapshot forward. */
async function upsertRecipeVersionForSnapshot(params: {
    tx: Prisma.TransactionClient;
    scenario: ApplyScenarioRecipeUpdateParams["scenario"];
    snapshotId: string;
    recipe: ScenarioRecipe;
    fingerprint: string;
}) {
    const { tx, scenario, snapshotId, recipe, fingerprint } = params;
    const schema = scenario.activeRecipeVersion.schemaSnapshot;

    const schemaSnapshot = await tx.scenarioSchemaSnapshot.upsert({
        where: { applicationId_snapshotId: { applicationId: scenario.applicationId, snapshotId } },
        create: {
            applicationId: scenario.applicationId,
            snapshotId,
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
        where: { scenarioId_snapshotId: { scenarioId: scenario.id, snapshotId } },
        create: {
            scenarioId: scenario.id,
            snapshotId,
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
