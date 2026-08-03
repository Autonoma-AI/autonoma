import { db } from "@autonoma/db";
import { logger as rootLogger } from "../logger";
import { resolveConfig } from "./resolver";
import type { PreviewConfig } from "./schema";

/**
 * Loads and resolves an Application's preview config - the single (latest-only)
 * `PreviewkitConfig` row - through `resolveConfig` (schema validation is the
 * only compatibility layer; there is no version-upgrade step). The document is
 * the whole topology: every app carries its `repository`, multirepo dependency
 * repos included.
 *
 * Returns undefined when the Application has no config row (the normal "this
 * repo hasn't adopted server-side config" signal). Throws on an invalid stored
 * document, and unexpected DB errors propagate, so the caller's deploy-level
 * error handling marks the deploy failed rather than silently skipping it.
 */
export async function loadConfig(applicationId: string): Promise<PreviewConfig | undefined> {
    const logger = rootLogger.child({ name: "loadConfig" });
    logger.info("Loading preview config", { applicationId });

    const stored = await db.previewkitConfig.findUnique({
        where: { applicationId },
        select: { document: true },
    });
    if (stored == null) {
        logger.info("No preview config for application", { applicationId });
        return undefined;
    }

    logger.info("Resolving preview config", { applicationId });
    // Stored configs are platform-authored, so per-app/service `resources`
    // overrides are trusted and honored here.
    return resolveConfig({ document: stored.document, allowCustomResources: true });
}
