import { db } from "@autonoma/db";
import { TestCatalog } from "@autonoma/investigation";
import { logger as rootLogger } from "@autonoma/logger";
import { ScenarioRecipeSchema } from "@autonoma/types";
import type { StageRecipeCandidateInput, StageRecipeCandidateOutput } from "@autonoma/workflow/activities";

/**
 * Stage a candidate recipe on the (detached) investigation twin so it can be validated before anything real is
 * touched: overwrite the twin recipe version's `create` graph with the candidate and create a fresh shadow
 * generation for the test. The workflow then re-seeds + re-runs that generation; only if it passes does it
 * activate the candidate on the real recipe. The twin is throwaway, so mutating its recipe version is safe.
 *
 * Returns `staged: false` when the test has no bound scenario or no twin recipe version - there is nothing to
 * validate, so the caller skips activation and keeps the dry-run proposal only.
 */
export async function stageRecipeCandidateOnTwin(
    input: StageRecipeCandidateInput,
): Promise<StageRecipeCandidateOutput> {
    const { snapshotId, slug, createGraphJson } = input;
    const logger = rootLogger.child({ name: "stageRecipeCandidateOnTwin", extra: { snapshotId, slug } });
    logger.info("Staging candidate recipe on the twin");

    const pinned = await new TestCatalog(db).resolveSnapshotPlan(snapshotId, slug);
    if (pinned?.scenarioId == null) {
        logger.info("Test has no bound scenario; nothing to stage");
        return { staged: false };
    }
    const scenarioId = pinned.scenarioId;

    const version = await db.scenarioRecipeVersion.findUnique({
        where: { scenarioId_snapshotId: { scenarioId, snapshotId } },
        select: { fixtureJson: true, organizationId: true },
    });
    if (version == null) {
        logger.info("No twin recipe version for this scenario/snapshot; nothing to stage");
        return { staged: false };
    }

    // Keep the recipe intact except for its create graph - the candidate only changes WHAT is seeded. Capture the
    // pre-stage create graph so the caller can restore it if the candidate fails validation, keeping the twin as
    // the branch's VALIDATED state (the merge-with-main step reads the twin, so a failed candidate must not linger).
    const base = ScenarioRecipeSchema.parse(version.fixtureJson);
    const previousCreateGraphJson = JSON.stringify(base.create);
    const candidateRecipe = { ...base, create: parseCreateGraph(createGraphJson) };
    await db.scenarioRecipeVersion.update({
        where: { scenarioId_snapshotId: { scenarioId, snapshotId } },
        data: { fixtureJson: candidateRecipe },
    });

    const generation = await db.testGeneration.create({
        data: { testPlanId: pinned.planId, snapshotId, organizationId: version.organizationId, shadow: true },
        select: { id: true },
    });

    logger.info("Candidate staged; created validation generation", { extra: { testGenerationId: generation.id } });
    return { staged: true, testGenerationId: generation.id, scenarioId, previousCreateGraphJson };
}

/** The candidate create graph arrives as a JSON string; validate it is an object before writing it into a recipe. */
function parseCreateGraph(createGraphJson: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(createGraphJson);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Candidate create graph is not a JSON object");
    }
    return { ...parsed };
}
