import { logger as rootLogger } from "../logger";
import { previewConfigSchema, type PreviewConfig, trustedPreviewConfigSchema } from "./schema";

/**
 * The config-document schema version this build understands. Stored on each
 * `PreviewkitConfigRevision` so older documents can be upgraded on read.
 * Distinct from the `.preview.yaml` `version` field (the config format
 * version), which the schema validates directly.
 */
export const CURRENT_CONFIG_SCHEMA_VERSION = 1;

export interface ResolveConfigInput {
    /** Raw config document: a parsed `.preview.yaml` object or a stored
     *  `PreviewkitConfigRevision.document`. Same shape as the schema input. */
    document: unknown;
    /** Version the document was written against. Defaults to current; the file
     *  path leaves it unset (the yaml's own `version` field is validated by
     *  the schema). */
    schemaVersion?: number;
    /** When true, honor any per-app/service `resources` overrides in the
     *  document; when false (default), discard them and apply the standard tier.
     *  Reserved for trusted, platform-authored sources (DB config revisions) -
     *  the `.preview.yaml` path leaves this false so a repo can't size its own
     *  preview. See `buildResourcesSchema` in `./schema`. */
    allowCustomResources?: boolean;
}

/**
 * Resolves a stored or file-sourced config document into a validated
 * `PreviewConfig`. One path shared by the `.preview.yaml` loader and the
 * DB-backed loader:
 *   1. upgrade the document from its `schemaVersion` to the current one,
 *   2. validate with the config schema (which also applies platform standards,
 *      e.g. the `resources` transform). The trusted variant is used when
 *      `allowCustomResources` is set so a DB revision's resource overrides are
 *      honored; otherwise the standard tier is forced.
 *
 * Throws `ZodError` on an invalid document (callers format it) or a plain
 * `Error` for an unsupported `schemaVersion`.
 */
export function resolveConfig(input: ResolveConfigInput): PreviewConfig {
    const logger = rootLogger.child({ name: "resolveConfig" });
    const fromVersion = input.schemaVersion ?? CURRENT_CONFIG_SCHEMA_VERSION;
    const allowCustomResources = input.allowCustomResources ?? false;

    const upgraded = upgradeConfigDocument(input.document, fromVersion);
    const config = allowCustomResources
        ? trustedPreviewConfigSchema.parse(upgraded)
        : previewConfigSchema.parse(upgraded);

    logger.debug("Resolved preview config", {
        fromVersion,
        allowCustomResources,
        apps: config.apps.length,
        services: config.services.length,
    });
    return config;
}

/**
 * vN -> current. v1 is the only version today, so this is a pass-through.
 * A future breaking change adds a case that rewrites the document shape
 * (v1 -> v2 -> ...), letting stored revisions be migrated server-side on read
 * instead of editing clients' configs.
 */
function upgradeConfigDocument(document: unknown, fromVersion: number): unknown {
    if (fromVersion === CURRENT_CONFIG_SCHEMA_VERSION) return document;
    if (fromVersion > CURRENT_CONFIG_SCHEMA_VERSION) {
        throw new Error(
            `Config schemaVersion ${fromVersion} is newer than this build supports (${CURRENT_CONFIG_SCHEMA_VERSION}); upgrade Previewkit.`,
        );
    }
    throw new Error(`No upgrader registered for config schemaVersion ${fromVersion}`);
}
