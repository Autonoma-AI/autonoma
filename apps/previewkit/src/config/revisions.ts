import { db } from "@autonoma/db";
import { logger as rootLogger } from "../logger";
import { resolveConfig } from "./resolver";
import type { PreviewConfig } from "./schema";

export interface ActiveConfig {
    config: PreviewConfig;
    revisionId: string;
}

/**
 * Loads and resolves a specific config revision, scoped to the owning Application.
 * Querying by both `id` AND `applicationId` means a revision id that belongs to a
 * different Application never resolves here - so a mis-set `activeConfigRevisionId`
 * (or a stale pinned id passed by a redeploy) can never make one Application deploy
 * another's config.
 *
 * Returns undefined when no such revision exists for this Application. Throws on an
 * invalid stored document (callers' deploy-level handling marks the deploy failed).
 */
export async function loadConfigRevision(applicationId: string, revisionId: string): Promise<ActiveConfig | undefined> {
    const logger = rootLogger.child({ name: "loadConfigRevision" });

    const revision = await db.previewkitConfigRevision.findFirst({
        where: { id: revisionId, applicationId },
        select: { id: true, schemaVersion: true, document: true },
    });
    if (revision == null) return undefined;

    logger.info("Resolving config revision", {
        applicationId,
        revisionId: revision.id,
        schemaVersion: revision.schemaVersion,
    });
    // Config revisions are platform-authored (not a repo's `.preview.yaml`), so
    // per-app/service `resources` overrides are trusted and honored here.
    const config = resolveConfig({
        document: revision.document,
        schemaVersion: revision.schemaVersion,
        allowCustomResources: true,
    });
    return { config, revisionId: revision.id };
}

/**
 * Resolves an Application's active config: its `activeConfigRevisionId` document, run
 * through the same upgrade + validation pipeline as the `.preview.yaml` path.
 *
 * Returns undefined when the Application has no active revision (the normal "this repo
 * hasn't adopted server-side config" signal) or when the active id dangles / points at
 * a revision outside this Application. Unexpected DB errors propagate so the caller's
 * deploy-level error handling marks the deploy failed rather than silently skipping it.
 */
export async function loadActiveConfig(applicationId: string): Promise<ActiveConfig | undefined> {
    const logger = rootLogger.child({ name: "loadActiveConfig" });
    logger.info("Loading active config", { applicationId });

    const application = await db.application.findUnique({
        where: { id: applicationId },
        select: { activeConfigRevisionId: true },
    });
    const revisionId = application?.activeConfigRevisionId;
    if (revisionId == null) {
        logger.info("No active config revision for application", { applicationId });
        return undefined;
    }

    const loaded = await loadConfigRevision(applicationId, revisionId);
    if (loaded == null) {
        logger.warn("Active config revision id points at a missing or foreign revision", { applicationId, revisionId });
    }
    return loaded;
}
