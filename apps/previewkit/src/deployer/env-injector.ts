import type { AppConfig, ServiceConfig } from "../config/schema";
import type { RecipeRegistry } from "../recipes/recipe-registry";

// Match K8s-style names (lowercase alnum + hyphens). `\w+` would drop hyphens,
// which silently broke services and apps named like `api-gateway`.
const SERVICE_TEMPLATE_REGEX = /\{\{([a-z0-9][a-z0-9-]*[a-z0-9])\.(host|port)\}\}/g;
const VARIABLE_TEMPLATE_REGEX = /\{\{(pr|namespace|owner)\}\}/g;

interface ServiceMap {
    [name: string]: { host: string; port: number };
}

interface ContextVariables {
    pr: string;
    namespace: string;
    owner: string;
}

export class EnvInjector {
    constructor(private recipeRegistry: RecipeRegistry) {}

    resolve(
        configEnv: Record<string, string>,
        storedSecrets: Record<string, string>,
        apps: AppConfig[],
        services: ServiceConfig[],
        namespace: string,
        context: ContextVariables,
    ): Record<string, string> {
        const merged = { ...storedSecrets, ...configEnv };

        const serviceMap = this.buildServiceMap(apps, services, namespace);
        const resolved: Record<string, string> = {};

        for (const [key, value] of Object.entries(merged)) {
            let result = value;

            result = result.replace(VARIABLE_TEMPLATE_REGEX, (_match, variable: string) => {
                return context[variable as keyof ContextVariables];
            });

            result = result.replace(SERVICE_TEMPLATE_REGEX, (_match, name: string, field: string) => {
                const svc = serviceMap[name];
                if (!svc) {
                    throw new Error(
                        `Unknown service/app reference "{{${name}.${field}}}" in env var ${key}. ` +
                            `Available names: ${Object.keys(serviceMap).join(", ")}`,
                    );
                }
                return field === "host" ? svc.host : String(svc.port);
            });

            resolved[key] = result;
        }

        return resolved;
    }

    private buildServiceMap(apps: AppConfig[], services: ServiceConfig[], _namespace: string): ServiceMap {
        const map: ServiceMap = {};

        for (const app of apps) {
            map[app.name] = {
                host: app.name,
                port: app.port,
            };
        }

        for (const svc of services) {
            const recipe = this.recipeRegistry.get(svc.recipe);
            const connInfo = recipe.connectionInfo(svc);
            map[svc.name] = {
                host: connInfo.host,
                port: connInfo.port,
            };
        }

        return map;
    }
}
