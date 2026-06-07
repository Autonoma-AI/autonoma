/**
 * Platform-owned configuration applied to every preview, independent of any
 * client's `.preview.yaml`. Consolidates settings that were previously
 * scattered across env vars (REGISTRY_URL, PREVIEW_DOMAIN, BUILD_TIMEOUT_MS)
 * and code constants (the standard container resources).
 *
 * Two tiers with opposite precedence against a client's config:
 *   - `defaults`: the platform's fallback - a client `.preview.yaml` value
 *     wins (e.g. `registry`, `domain`). Resolved as `clientValue ?? default`.
 *   - `standards`: platform policy the client cannot override (e.g. container
 *     `resources`). Applied OVER the client config; client values are ignored.
 *
 * This is a plain object built from env for now. When per-org variation or
 * runtime tuning is needed, it becomes the shape loaded from a
 * `PreviewkitDefaults` table - consumers and the resolver stay the same.
 */

/**
 * Standard resource allocation applied to every app and service container.
 * CPU is requested but not limited (CPU limits cause throttling at the
 * boundary); memory is both requested and limited. This is the canonical
 * source; the `resources` schema transform reads it to ignore client input.
 */
export const STANDARD_RESOURCES = { cpu: "1000m", memory: "1Gi" } as const;

export interface PreviewkitDefaults {
    /** Platform fallbacks; a client `.preview.yaml` value takes precedence. */
    defaults: {
        registry: string;
        domain: string;
        buildTimeoutMs: number;
    };
    /** Platform policy; client config cannot override these. */
    standards: {
        resources: { cpu: string; memory: string };
    };
}

/** The subset of validated env this module reads. Passed in, never read from
 *  `process.env` directly (see CLAUDE.md env conventions). */
export interface PreviewkitDefaultsEnv {
    REGISTRY_URL: string;
    PREVIEW_DOMAIN: string;
    BUILD_TIMEOUT_MS: number;
}

export function createPreviewkitDefaults(env: PreviewkitDefaultsEnv): PreviewkitDefaults {
    return {
        defaults: {
            registry: env.REGISTRY_URL,
            domain: env.PREVIEW_DOMAIN,
            buildTimeoutMs: env.BUILD_TIMEOUT_MS,
        },
        standards: {
            resources: { cpu: STANDARD_RESOURCES.cpu, memory: STANDARD_RESOURCES.memory },
        },
    };
}
