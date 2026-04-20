import type { ServiceConfig } from "../config/schema";
import type { Recipe, RecipeResources, RecipeConnectionInfo } from "./recipe";

const DEFAULT_PORT = 7233;

/**
 * Temporal recipe - connects to a shared Temporal cluster.
 *
 * Unlike postgres/redis, this recipe does NOT deploy any infrastructure.
 * It provides connection info that points to an existing shared cluster.
 * Each preview gets isolation via a unique Temporal namespace and task queue
 * derived from the PR number.
 *
 * Usage in .preview.yaml:
 *
 *   services:
 *     - name: temporal
 *       recipe: temporal
 *       env:
 *         address: "temporal.shared.svc.cluster.local:7233"
 *
 *   apps:
 *     - name: api
 *       env:
 *         TEMPORAL_ADDRESS: "{{temporal.host}}:{{temporal.port}}"
 *         TEMPORAL_NAMESPACE: "preview-pr-{{pr}}"
 *         TEMPORAL_TASK_QUEUE: "pr-{{pr}}-default"
 */
export class TemporalRecipe implements Recipe {
    readonly name = "temporal";

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        const address = config.env["address"] ?? `temporal.shared.svc.cluster.local:${DEFAULT_PORT}`;
        const parts = address.split(":");
        const host = parts[0]!;
        const port = parts.length > 1 ? Number(parts[1]) : DEFAULT_PORT;

        return { host, port };
    }

    generate(_config: ServiceConfig, _namespace: string): RecipeResources {
        return {
            deployments: [],
            services: [],
            statefulSets: [],
            configMaps: [],
            persistentVolumeClaims: [],
        };
    }
}
