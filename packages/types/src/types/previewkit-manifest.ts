import { previewConfigSchema } from "../schemas/previewkit-config";

/**
 * The manifest-shaped projection of a preview environment's stored `resolvedConfig` - the topology every reader
 * needs (which apps and services the deploy shipped, and which app is primary or hosts the SDK handler)
 * without carrying the whole merged config around.
 */
export type PreviewkitManifest = {
    apps?: Array<{ name: string; port?: number; primary?: boolean; sdk_implemented?: boolean }>;
    services?: Array<{ name: string; recipe?: string; version?: string }>;
};

/**
 * Projects the manifest-shaped subset from a stored resolved config. The merged config is the single source of
 * truth - there is no separate manifest column - so this parses it at read time. Returns an empty projection when
 * the config is absent or unparseable (e.g. a deploy that has not resolved its config yet).
 */
export function projectManifest(resolvedConfig: unknown): PreviewkitManifest {
    const parsed = previewConfigSchema.safeParse(resolvedConfig);
    if (!parsed.success) return {};
    return {
        apps: parsed.data.apps.map((app) => ({
            name: app.name,
            port: app.port,
            primary: app.primary ?? undefined,
            sdk_implemented: app.sdk_implemented ?? undefined,
        })),
        services: parsed.data.services.map((service) => ({
            name: service.name,
            recipe: service.recipe,
            version: service.version,
        })),
    };
}
