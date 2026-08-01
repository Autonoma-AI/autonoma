import type { AppConfig, ServiceConfig } from "../config/schema";
import type { RecipeRegistry } from "../recipes/recipe-registry";
import { buildAppHostname } from "./resource-factory";

// Match K8s-style names (lowercase alnum + hyphens). `\w+` would drop hyphens,
// which silently broke services and apps named like `api-gateway`.
const SERVICE_TEMPLATE_REGEX = /\{\{([a-z0-9][a-z0-9-]*[a-z0-9])\.(host|port|url|hostname)\}\}/g;
const VARIABLE_TEMPLATE_REGEX = /\{\{(pr|namespace|owner)\}\}/g;

interface ServiceEntry {
    host: string;
    port: number;
    url?: string;
    hostname?: string;
}

interface ServiceMap {
    [name: string]: ServiceEntry;
}

interface ContextVariables {
    pr: string;
    namespace: string;
    owner: string;
}

/**
 * Everything the injector needs to render the public preview URL for an app.
 * The hostname is an HMAC-SHA256 of (appName, prNumber, repoFullName) keyed on
 * secret — deterministic per (app, PR, repo) but unguessable without the key.
 */
export interface PublicUrlInfo {
    domain: string;
    repoFullName: string;
    prNumber: number;
    secret: string;
}

export class EnvInjector {
    constructor(private recipeRegistry: RecipeRegistry) {}

    /**
     * Resolves an app's topology connections into runtime env vars. Each
     * connection's `value` is a template (e.g. `mongodb://{{db.host}}:{{db.port}}/x`)
     * templated against the live app / service map (see {@link applyTemplates}).
     *
     * Connections are the ONLY non-secret runtime env. Everything a user types
     * is a secret, stored in the per-app AWS Secrets Manager bundle and mounted
     * via ExternalSecretsOperator's `envFrom: secretRef` INDEPENDENTLY of this
     * function. If a connection key and a secret key collide, the Kubernetes
     * `env:` list (this function's output) wins over `envFrom`, matching the
     * kubectl rule - so a connection is also the override channel.
     */
    resolveConnections(
        connections: AppConfig["connections"],
        apps: AppConfig[],
        services: ServiceConfig[],
        namespace: string,
        context: ContextVariables,
        publicUrlInfo: PublicUrlInfo,
    ): Record<string, string> {
        const values: Record<string, string> = {};
        for (const connection of connections) {
            values[connection.key] = connection.value;
        }
        return this.applyTemplates(values, apps, services, namespace, context, publicUrlInfo);
    }

    /**
     * Pure templating over a value map. Used for build-time args and indirectly
     * by `resolveConnections` for runtime env. Available substitutions:
     *   - `{{pr}}`, `{{namespace}}`, `{{owner}}`
     *   - `{{<name>.host}}` — in-cluster DNS of an app or service
     *   - `{{<name>.port}}` — in-cluster port of an app or service
     *   - `{{<name>.url}}`  — public HTTPS URL of an app, or the in-cluster
     *     connection string of a service whose recipe defines one (postgres ->
     *     `postgresql://…`, redis/valkey -> `redis://…`, mongodb -> `mongodb://…`)
     */
    applyTemplates(
        values: Record<string, string>,
        apps: AppConfig[],
        services: ServiceConfig[],
        _namespace: string,
        context: ContextVariables,
        publicUrlInfo: PublicUrlInfo,
    ): Record<string, string> {
        const serviceMap = this.buildServiceMap(apps, services, publicUrlInfo);
        const resolved: Record<string, string> = {};

        for (const [key, value] of Object.entries(values)) {
            let result = value;

            result = result.replace(VARIABLE_TEMPLATE_REGEX, (_match, variable: string) => {
                return context[variable as keyof ContextVariables];
            });

            result = result.replace(SERVICE_TEMPLATE_REGEX, (_match, name: string, field: string) => {
                return this.resolveReference(name, field, key, serviceMap);
            });

            resolved[key] = result;
        }

        return resolved;
    }

    /** Looks up `{{name.field}}` against the app/service map. Throws with a list of available names when nothing matches. */
    private resolveReference(name: string, field: string, sourceKey: string, serviceMap: ServiceMap): string {
        const svc = serviceMap[name];
        if (svc == null) {
            const names = Object.keys(serviceMap).sort().join(", ");
            throw new Error(
                `Unknown reference "{{${name}.${field}}}" in ${sourceKey}. Available names: ${names || "(none)"}.`,
            );
        }

        if (field === "url") {
            if (svc.url == null) {
                throw new Error(
                    `{{${name}.url}} is not available: the "${name}" service exposes no connection URL. ` +
                        `Use {{${name}.host}} and {{${name}.port}} for in-cluster access.`,
                );
            }
            return svc.url;
        }
        if (field === "hostname") {
            if (svc.hostname == null) {
                throw new Error(
                    `{{${name}.hostname}} is only available for apps. ` +
                        `"${name}" is a service (no public hostname). Use {{${name}.host}} for in-cluster access.`,
                );
            }
            return svc.hostname;
        }
        if (field === "host") return svc.host;
        return String(svc.port);
    }

    private buildServiceMap(apps: AppConfig[], services: ServiceConfig[], publicUrlInfo: PublicUrlInfo): ServiceMap {
        const map: ServiceMap = {};

        for (const app of apps) {
            const hostname = buildAppHostname(
                app.name,
                publicUrlInfo.prNumber,
                publicUrlInfo.repoFullName,
                publicUrlInfo.domain,
                publicUrlInfo.secret,
            );
            map[app.name] = {
                host: app.name,
                port: app.port,
                url: `https://${hostname}`,
                hostname,
            };
        }

        for (const svc of services) {
            const recipe = this.recipeRegistry.get(svc.recipe);
            const connInfo = recipe.connectionInfo(svc);
            map[svc.name] = {
                host: connInfo.host,
                port: connInfo.port,
                url: connInfo.url,
            };
        }

        return map;
    }
}
