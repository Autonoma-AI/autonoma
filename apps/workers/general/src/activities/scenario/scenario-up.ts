import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { GenerationSubject, type ScenarioManager } from "@autonoma/scenario";

export interface ScenarioUpParams {
    entityId: string;
    sdkUrlOverride?: string;
}

export interface ScenarioUpDeps {
    db: PrismaClient;
    manager: ScenarioManager;
}

/**
 * Provisions a scenario instance for a run/generation and returns the instance
 * id. This function is free of any process-global state (no file I/O), so it is
 * safe to invoke concurrently within a single process - the in-process worker
 * activity runs up to 10 of these in parallel. Callers that need to surface the
 * id across a process boundary (the standalone container entrypoint) own that
 * side effect themselves.
 */
export async function scenarioUp(params: ScenarioUpParams, deps: ScenarioUpDeps): Promise<string> {
    const { entityId } = params;
    const { db, manager } = deps;
    const logger = rootLogger.child({ name: "scenarioUp", entityId });

    logger.info("Resolving scenario context");
    const subject = new GenerationSubject(db, entityId);
    const { scenarioId, snapshotId } = await resolveScenarioContext(db, entityId, logger);
    logger.info("Scenario context resolved", { scenarioId, snapshotId });

    const instance = await manager.up(subject, scenarioId, { snapshotId, sdkUrlOverride: params.sdkUrlOverride });

    if (instance.status === "UP_FAILED") {
        logger.error("Scenario up failed", { instanceId: instance.id, lastError: instance.lastError });
        // Surface the underlying error message (e.g. "SDK returned HTTP 500")
        // as the primary message so it flows cleanly through to the failure
        // panel, while carrying the instance id on `cause` so it is preserved
        // in the error chain (Temporal history, Sentry) for debugging.
        throw new Error(instance.lastError?.message ?? "Scenario environment failed to start", {
            cause: new Error(`scenario instance ${instance.id} failed to come up`),
        });
    }

    logger.info("Scenario instance started", { instanceId: instance.id });
    return instance.id;
}

async function resolveScenarioContext(
    db: PrismaClient,
    entityId: string,
    logger: ReturnType<typeof rootLogger.child>,
): Promise<{ scenarioId: string; snapshotId: string }> {
    const generation = await db.testGeneration.findUniqueOrThrow({
        where: { id: entityId },
        select: {
            snapshotId: true,
            testPlan: { select: { scenarioId: true } },
        },
    });
    const scenarioId = generation.testPlan.scenarioId;
    if (scenarioId == null) {
        logger.error("scenarioUp called but generation test plan has no linked scenario", { entityId });
        throw new Error(`Generation ${entityId} has no linked scenario`);
    }
    if (generation.snapshotId == null) {
        logger.error("Generation has no linked snapshot", { entityId });
        throw new Error(`Generation ${entityId} has no linked snapshot`);
    }
    return { scenarioId, snapshotId: generation.snapshotId };
}
