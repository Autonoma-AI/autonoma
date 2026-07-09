import { CURRENT_CONFIG_SCHEMA_VERSION } from "@autonoma/types";
import { logger as rootLogger } from "../logger";
import { previewConfigSchema, type PreviewConfig, trustedPreviewConfigSchema } from "./schema";

export { CURRENT_CONFIG_SCHEMA_VERSION };

export interface ResolveConfigInput {
    /** Raw config document: a stored `PreviewkitConfigRevision.document`.
     *  Same shape as the schema input. */
    document: unknown;
    /** Version the document was written against. Defaults to current (the
     *  document's own `version` field is validated by the schema). */
    schemaVersion?: number;
    /** When true, honor any per-app/service `resources` overrides in the
     *  document; when false (default), discard them and apply the standard tier.
     *  Reserved for trusted, platform-authored sources (DB config revisions);
     *  untrusted client input leaves this false so it can't size its own
     *  preview. See `buildResourcesSchema` in `./schema`. */
    allowCustomResources?: boolean;
}

/**
 * Resolves a stored config document (a `PreviewkitConfigRevision.document`) into
 * a validated `PreviewConfig`:
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
 * vN -> current. Two shapes exist today, both parseable by the current schema:
 *   - v1: the legacy inline-secrets model (app `env` / `build_args`, service `env`).
 *   - v2: the secrets/connections model the env/build_args migration produced
 *     (`apps/api/.../migrate-preview-config-secrets`, stamped MIGRATED_SCHEMA_VERSION = 2).
 *
 * The current `previewConfigSchema` is the v2 shape and strips the retired v1
 * inline fields, so a v1 document upgrades to v2 by passing straight through to
 * the schema (which drops `env`/`build_args` and defaults `connections` /
 * `build_secrets`). The literal secret values a v1 document carried inline were
 * moved to AWS Secrets Manager by the one-time migration, not re-derived here.
 * A future breaking change adds a case that rewrites the document shape
 * (v2 -> v3 -> ...) instead of editing clients' configs.
 */
function upgradeConfigDocument(document: unknown, fromVersion: number): unknown {
    if (fromVersion === CURRENT_CONFIG_SCHEMA_VERSION) return document;
    if (fromVersion > CURRENT_CONFIG_SCHEMA_VERSION) {
        throw new Error(
            `Config schemaVersion ${fromVersion} is newer than this build supports (${CURRENT_CONFIG_SCHEMA_VERSION}); upgrade Previewkit.`,
        );
    }
    if (fromVersion === 1) return document;
    throw new Error(`No upgrader registered for config schemaVersion ${fromVersion}`);
}
