import { db } from "@autonoma/db";
import { z } from "zod";
import { logger as rootLogger } from "../logger";
import { resolveConfig } from "./resolver";
import type { PreviewConfig } from "./schema";

/** A multirepo dependency's config, resolved from the primary revision's `dependencyDocuments`. */
export interface DependencyConfig {
    /** Repo full name (`owner/repo`). */
    repo: string;
    config: PreviewConfig;
}

export interface ActiveConfig {
    config: PreviewConfig;
    revisionId: string;
    /** Dependency-repo configs owned by this (primary) revision; [] for single-repo projects. */
    dependencyConfigs: DependencyConfig[];
}

const storedDependencyDocumentsSchema = z.array(z.object({ repo: z.string(), document: z.unknown() }));

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
        select: { id: true, schemaVersion: true, document: true, dependencyDocuments: true },
    });
    if (revision == null) return undefined;

    logger.info("Resolving config revision", {
        applicationId,
        revisionId: revision.id,
        schemaVersion: revision.schemaVersion,
    });
    // Config revisions are platform-authored, so per-app/service `resources`
    // overrides are trusted and honored here.
    const config = resolveConfig({
        document: revision.document,
        schemaVersion: revision.schemaVersion,
        allowCustomResources: true,
    });
    const dependencyConfigs = resolveDependencyConfigs(revision.dependencyDocuments, revision.schemaVersion, logger);
    return { config, revisionId: revision.id, dependencyConfigs };
}

/**
 * Resolves the primary revision's stored `dependencyDocuments` (one validated
 * config per multirepo dependency) through the same upgrade/validate pipeline as
 * the primary. A shape that no longer parses degrades to [] (logged) rather than
 * failing the whole deploy on a corrupt sidecar.
 */
function resolveDependencyConfigs(
    value: unknown,
    schemaVersion: number,
    logger: ReturnType<typeof rootLogger.child>,
): DependencyConfig[] {
    if (value == null) return [];
    const parsed = storedDependencyDocumentsSchema.safeParse(value);
    if (!parsed.success) {
        logger.warn("Stored dependencyDocuments did not parse; treating as single-repo");
        return [];
    }
    return parsed.data.map((entry) => ({
        repo: entry.repo,
        config: resolveConfig({ document: entry.document, schemaVersion, allowCustomResources: true }),
    }));
}

/**
 * Resolves an Application's active config: its `activeConfigRevisionId` document, run
 * through the upgrade + validation pipeline in `resolveConfig`.
 *
 * Returns undefined when the Application has no active revision (the normal "this repo
 * hasn't adopted server-side config" signal) or when the active id points at a revision
 * owned by a different Application (the FK on `activeConfigRevisionId` makes a truly
 * dangling id impossible). Unexpected DB errors propagate so the caller's deploy-level
 * error handling marks the deploy failed rather than silently skipping it.
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
        logger.warn("Active config revision id points at a revision owned by another application", {
            applicationId,
            revisionId,
        });
    }
    return loaded;
}
