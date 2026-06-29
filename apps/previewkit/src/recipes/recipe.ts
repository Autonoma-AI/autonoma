import type * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import type { ServiceConfig } from "../config/schema";

export interface RecipeResources {
    deployments: k8s.V1Deployment[];
    services: k8s.V1Service[];
    statefulSets: k8s.V1StatefulSet[];
    configMaps: k8s.V1ConfigMap[];
    persistentVolumeClaims: k8s.V1PersistentVolumeClaim[];
}

export interface RecipeConnectionInfo {
    host: string;
    port: number;
    /**
     * In-cluster connection string the env-injector returns for
     * `{{<service>.url}}`, when the service speaks a well-known scheme
     * (e.g. postgres -> `postgresql://preview:preview@<host>:<port>/preview`,
     * redis -> `redis://<host>:<port>`). Recipes whose `.url` has no
     * unambiguous meaning (temporal gRPC, api-gateway HTTP) leave this
     * undefined, and `{{<name>.url}}` throws with a helpful message pointing
     * at `.host`/`.port`.
     */
    url?: string;
}

// Recipes that need typed options (e.g. docker-image) set TOptions to a
// schema-inferred type. Recipes that don't care leave it as the default
// Record<string, unknown> and parseOptions is a passthrough.
//
// Callers use `generate` (raw config in). Internally, every recipe follows
// the template: `generate` runs `parseOptions` then delegates to
// `typedGenerate`, which works with the typed options directly. Tests and
// internal composition can call `typedGenerate` to skip the parse step.
export interface Recipe<TOptions = unknown> {
    readonly name: string;
    parseOptions(config: ServiceConfig): TOptions;
    generate(config: ServiceConfig, namespace: string): RecipeResources;
    typedGenerate(config: ServiceConfig<TOptions>, namespace: string): RecipeResources;
    connectionInfo(config: ServiceConfig): RecipeConnectionInfo;
}

// BaseRecipe ties TOptions to a Zod schema: subclasses must declare a
// `schema: z.ZodType<TOptions>`, and the default `parseOptions` validates
// `config.options` through it. typedGenerate therefore only sees options
// that were schema-validated. Wrapper recipes (redis, valkey) override
// parseOptions to construct options programmatically - the schema still
// pins the typed shape.
export abstract class BaseRecipe<TOptions = Record<string, unknown>> implements Recipe<TOptions> {
    abstract readonly name: string;
    abstract readonly schema: z.ZodType<TOptions>;
    abstract typedGenerate(config: ServiceConfig<TOptions>, namespace: string): RecipeResources;
    abstract connectionInfo(config: ServiceConfig): RecipeConnectionInfo;

    parseOptions(config: ServiceConfig): TOptions {
        const result = this.schema.safeParse(config.options);
        if (!result.success) {
            throw new Error(`Invalid options for ${this.name} recipe (service "${config.name}")`, {
                cause: result.error,
            });
        }
        return result.data;
    }

    generate(config: ServiceConfig, namespace: string): RecipeResources {
        const options = this.parseOptions(config);
        return this.typedGenerate({ ...config, options }, namespace);
    }
}

// Permissive schema for recipes that don't actually use options from YAML.
export const passthroughOptionsSchema = z.record(z.string(), z.unknown());
