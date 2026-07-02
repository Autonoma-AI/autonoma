import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { ScenarioRecipeSchema } from "@autonoma/types";
import type { RevertTwinRecipeInput, RevertTwinRecipeOutput } from "@autonoma/workflow/activities";

/**
 * Restore a scenario's twin recipe version to a previous `create` graph - the inverse of
 * stageRecipeCandidateOnTwin. Called when a staged candidate FAILS validation, so the twin holds only the
 * branch's validated recipe state; the merge-with-main step reads the twin, so a failed candidate must not
 * linger there and get carried into main as a "branch recipe edit". Branch-scoped: touches only the twin's
 * recipe version, never main. Returns `reverted: false` when there's no version to restore, so the caller moves on.
 */
export async function revertTwinRecipe(input: RevertTwinRecipeInput): Promise<RevertTwinRecipeOutput> {
    const { snapshotId, scenarioId, createGraphJson } = input;
    const logger = rootLogger.child({ name: "revertTwinRecipe", extra: { snapshotId, scenarioId } });
    logger.info("Reverting twin recipe candidate after failed validation");

    const version = await db.scenarioRecipeVersion.findUnique({
        where: { scenarioId_snapshotId: { scenarioId, snapshotId } },
        select: { fixtureJson: true },
    });
    if (version == null) {
        logger.info("No twin recipe version to revert; nothing to do");
        return { reverted: false };
    }

    const base = ScenarioRecipeSchema.parse(version.fixtureJson);
    const restored = { ...base, create: parseCreateGraph(createGraphJson) };
    await db.scenarioRecipeVersion.update({
        where: { scenarioId_snapshotId: { scenarioId, snapshotId } },
        data: { fixtureJson: restored },
    });

    logger.info("Twin recipe reverted");
    return { reverted: true };
}

/** The previous create graph arrives as a JSON string; validate it is an object before writing it into a recipe. */
function parseCreateGraph(createGraphJson: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(createGraphJson);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Previous create graph is not a JSON object");
    }
    return { ...parsed };
}
