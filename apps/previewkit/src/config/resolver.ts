import { logger as rootLogger } from "../logger";
import { previewConfigSchema, type PreviewConfig, trustedPreviewConfigSchema } from "./schema";

export interface ResolveConfigInput {
    /** Raw config document: a stored `PreviewkitConfigRevision.document`.
     *  Same shape as the schema input. */
    document: unknown;
    /** When true, honor any per-app/service `resources` overrides in the
     *  document; when false (default), discard them and apply the standard tier.
     *  Reserved for trusted, platform-authored sources (DB config revisions);
     *  untrusted client input leaves this false so it can't size its own
     *  preview. See `buildResourcesSchema` in `./schema`. */
    allowCustomResources?: boolean;
}

/**
 * Resolves a stored config document (a `PreviewkitConfigRevision.document`) into
 * a validated `PreviewConfig` by validating it with the config schema (which also
 * applies platform standards, e.g. the `resources` transform). The trusted variant
 * is used when `allowCustomResources` is set so a DB revision's resource overrides
 * are honored; otherwise the standard tier is forced.
 *
 * The schema is the compatibility layer: it strips fields retired across config
 * shapes (the legacy inline `env` / `build_args`) and defaults their replacements
 * (`connections` / `build_secrets`), so any stored document parses without a
 * separate version-upgrade step.
 *
 * Throws `ZodError` on an invalid document (callers format it).
 */
export function resolveConfig(input: ResolveConfigInput): PreviewConfig {
    const logger = rootLogger.child({ name: "resolveConfig" });
    const allowCustomResources = input.allowCustomResources ?? false;

    const config = allowCustomResources
        ? trustedPreviewConfigSchema.parse(input.document)
        : previewConfigSchema.parse(input.document);

    logger.debug("Resolved preview config", {
        allowCustomResources,
        apps: config.apps.length,
        services: config.services.length,
    });
    return config;
}
