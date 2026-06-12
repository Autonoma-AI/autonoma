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

/** Resource allocation for a single container. CPU and memory requests drive
 *  node provisioning (Karpenter schedules off requests); the memory limit only
 *  caps bursting and reserves nothing. */
export interface ContainerResources {
    cpu: string;
    memoryRequest: string;
    memoryLimit: string;
}

/**
 * Standard resource allocations, tiered by container role. Preview workloads
 * idle most of their lifetime, so requests are sized for the idle baseline
 * and bursting covers the rest:
 *   - CPU is requested but never limited (CPU limits cause throttling at the
 *     boundary), so the request is pure scheduling reservation - boot and
 *     load spikes borrow whatever the node has free.
 *   - Memory requests are sized to typical idle footprint; the limit stays at
 *     1Gi so peak behavior is unchanged - only bin-packing improves.
 *
 * Tiers:
 *   - `app`: client application containers (built images).
 *   - `service`: recipe-provisioned services (postgres, redis, mongodb, ...),
 *     which idle far below app containers in a preview.
 *
 * This is the canonical source; the `resources` schema transforms read it to
 * ignore client input.
 */
export const STANDARD_RESOURCES = {
    app: { cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" },
    service: { cpu: "100m", memoryRequest: "256Mi", memoryLimit: "1Gi" },
} as const;

/**
 * Upper bound on per-app `replicas`. Platform policy, not client-tunable:
 * every replica multiplies the standard allocation, and a preview never
 * needs horizontal scale. Values above the cap are clamped, not rejected,
 * so existing configs keep validating.
 */
export const MAX_REPLICAS = 3;

export interface PreviewkitDefaults {
    /** Platform fallbacks; a client `.preview.yaml` value takes precedence. */
    defaults: {
        registry: string;
        domain: string;
        buildTimeoutMs: number;
    };
    /** Platform policy; client config cannot override these. */
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
