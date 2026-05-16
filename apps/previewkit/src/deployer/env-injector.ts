import type { AppConfig, ServiceConfig } from "../config/schema";
import type { RecipeRegistry } from "../recipes/recipe-registry";
import { buildAppHostname } from "./resource-factory";

// Match K8s-style names (lowercase alnum + hyphens). `\w+` would drop hyphens,
// which silently broke services and apps named like `api-gateway`.
const SERVICE_TEMPLATE_REGEX = /\{\{([a-z0-9][a-z0-9-]*[a-z0-9])\.(host|port|url)\}\}/g;
const VARIABLE_TEMPLATE_REGEX = /\{\{(pr|namespace|owner)\}\}/g;

interface ServiceEntry {
    host: string;
    port: number;
    // Only present for apps — services aren't publicly exposed. Accessing
    // `.url` on a service-only entry raises a clear error.
    url?: string;
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
 * Everything the injector needs to render the public preview URL for an app:
 *   `https://{appName}-pr-{prNumber}-{repoSlug}.{domain}`
 */
export interface PublicUrlInfo {
    domain: string;
    repoSlug: string;
    prNumber: number;
}

export class EnvInjector {
    constructor(private recipeRegistry: RecipeRegistry) {}

    /**
     * Resolves runtime env: stored secrets merged with `.preview.yaml` env,
     * with `.preview.yaml` values winning, then templated.
     */
    resolve(
        configEnv: Record<string, string>,
        storedSecrets: Record<string, string>,
        apps: AppConfig[],
        services: ServiceConfig[],
        namespace: string,
        context: ContextVariables,
        publicUrlInfo: PublicUrlInfo,
    ): Record<string, string> {
        const merged = { ...storedSecrets, ...configEnv };
        return this.applyTemplates(merged, apps, services, namespace, context, publicUrlInfo);
    }

    /**
     * Pure templating over a value map. Used for build_args (no secret merge)
     * and indirectly by `resolve` for env. Available substitutions:
     *   - `{{pr}}`, `{{namespace}}`, `{{owner}}`
     *   - `{{<name>.host}}` — in-cluster DNS of an app or service
     *   - `{{<name>.port}}` — in-cluster port of an app or service
     *   - `{{<name>.url}}`  — public HTTPS URL of an app (apps only)
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
                const svc = serviceMap[name];
                if (!svc) {
                    throw new Error(
                        `Unknown service/app reference "{{${name}.${field}}}" in ${key}. ` +
                            `Available names: ${Object.keys(serviceMap).join(", ")}`,
                    );
                }
                if (field === "url") {
                    if (svc.url == null) {
                        throw new Error(
                            `{{${name}.url}} is only available for apps. ` +
                                `"${name}" is a service (no public URL). Use {{${name}.host}} for in-cluster access.`,
                        );
                    }
                    return svc.url;
                }
                return field === "host" ? svc.host : String(svc.port);
            });

            resolved[key] = result;
        }

        return resolved;
    }

    private buildServiceMap(apps: AppConfig[], services: ServiceConfig[], publicUrlInfo: PublicUrlInfo): ServiceMap {
        const map: ServiceMap = {};

        for (const app of apps) {
            const hostname = buildAppHostname(
                app.name,
                publicUrlInfo.prNumber,
                publicUrlInfo.repoSlug,
                publicUrlInfo.domain,
            );
            map[app.name] = {
                host: app.name,
                port: app.port,
                url: `https://${hostname}`,
            };
        }

        for (const svc of services) {
            const recipe = this.recipeRegistry.get(svc.recipe);
            const connInfo = recipe.connectionInfo(svc);
            map[svc.name] = {
                host: connInfo.host,
                port: connInfo.port,
                // url intentionally omitted — services aren't publicly exposed
            };
        }

        return map;
    }
}
