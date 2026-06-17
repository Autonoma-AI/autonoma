/**
 * Platform-owned configuration applied to every preview, independent of any
 * client's `.preview.yaml`. Consolidates settings that were previously
 * scattered across env vars (REGISTRY_URL, PREVIEW_DOMAIN, BUILD_TIMEOUT_MS)
 * and code constants (the standard container resources).
 *
 * Two tiers with different precedence against a client's config:
 *   - `defaults`: the platform's fallback - a client `.preview.yaml` value
 *     wins (e.g. `registry`, `domain`). Resolved as `clientValue ?? default`.
 *   - `standards`: platform defaults for omitted resource values and the
 *     maximum replica policy.
 *
 * This is a plain object built from env for now. When per-org variation or
 * runtime tuning is needed, it becomes the shape loaded from a
 * `PreviewkitDefaults` table - consumers and the resolver stay the same.
 */

import { MAX_REPLICAS, STANDARD_RESOURCES, type ContainerResources } from "@autonoma/types";

export { MAX_REPLICAS, STANDARD_RESOURCES };
export type { ContainerResources };

export interface PreviewkitDefaults {
    /** Platform fallbacks; a client `.preview.yaml` value takes precedence. */
    defaults: {
        registry: string;
        domain: string;
        buildTimeoutMs: number;
    };
    /** Platform defaults for omitted resource values and replica counts. */
    standards: {
        resources: {
            app: ContainerResources;
            service: ContainerResources;
        };
        maxReplicas: number;
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
            resources: {
                app: {
                    cpu: STANDARD_RESOURCES.app.cpu,
                    memoryRequest: STANDARD_RESOURCES.app.memoryRequest,
                    memoryLimit: STANDARD_RESOURCES.app.memoryLimit,
                },
                service: {
                    cpu: STANDARD_RESOURCES.service.cpu,
                    memoryRequest: STANDARD_RESOURCES.service.memoryRequest,
                    memoryLimit: STANDARD_RESOURCES.service.memoryLimit,
                },
            },
            maxReplicas: MAX_REPLICAS,
        },
    };
}
