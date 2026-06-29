import type { AppConfig, ServiceConfig } from "../config/schema";
import type { RecipeRegistry } from "../recipes/recipe-registry";
import { buildAppHostname } from "./resource-factory";

// Match K8s-style names (lowercase alnum + hyphens). `\w+` would drop hyphens,
// which silently broke services and apps named like `api-gateway`.
//
// The field part used to be a fixed `host|port|url` whitelist. With addons in
// the mix it's widened to any identifier-shaped token — the *resolver* now
// distinguishes valid app/service fields (host/port/url) from provider-defined
// addon output keys (whatever the provider returned). Unknown tokens still
// throw with a helpful message.
const SERVICE_TEMPLATE_REGEX = /\{\{([a-z0-9][a-z0-9-]*[a-z0-9])\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
const VARIABLE_TEMPLATE_REGEX = /\{\{(pr|namespace|owner)\}\}/g;

/**
 * Per-addon outputs produced by `AddonManager.provisionAll`. The outer key
 * is the addon name from the preview config; the inner map is the provider's
 * declared outputs (e.g. NeonProvider returns `{ connectionString, host,
 * database }`). Apps reference these as `{{addonName.<key>}}`.
 */
export type AddonOutputs = Record<string, Record<string, string>>;

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
     * Resolves runtime env from the preview config by templating its values.
     *
     * Sensitive runtime env (API keys, third-party credentials) lives in the
     * per-app AWS Secrets Manager bundle and is mounted into the pod via
     * ExternalSecretsOperator's `envFrom: secretRef`, which lands those keys
     * as environment variables INDEPENDENTLY of this function. If both the
     * AWS SM bundle and the preview config's `env:` define the same key, the
     * Kubernetes `env:` list (i.e. this function's output) wins over
     * `envFrom`, matching the kubectl rule. Treat that as the override
     * channel for committed switches like PLAID_ENV / SEND_EMAILS_LOCALLY.
     */
    resolve(
        configEnv: Record<string, string>,
        apps: AppConfig[],
        services: ServiceConfig[],
        namespace: string,
        context: ContextVariables,
        publicUrlInfo: PublicUrlInfo,
        addonOutputs: AddonOutputs = {},
    ): Record<string, string> {
        return this.applyTemplates(configEnv, apps, services, namespace, context, publicUrlInfo, addonOutputs);
    }

    /**
     * Pure templating over a value map. Used for build_args (no secret merge)
     * and indirectly by `resolve` for env. Available substitutions:
     *   - `{{pr}}`, `{{namespace}}`, `{{owner}}`
     *   - `{{<name>.host}}` — in-cluster DNS of an app or service
     *   - `{{<name>.port}}` — in-cluster port of an app or service
     *   - `{{<name>.url}}`  — public HTTPS URL of an app, or the in-cluster
     *     connection string of a service whose recipe defines one (postgres ->
     *     `postgresql://…`, redis/valkey -> `redis://…`, mongodb -> `mongodb://…`)
     *   - `{{<addonName>.<key>}}` — provider-defined output from a
     *     successfully provisioned addon (e.g. `{{db.connectionString}}`).
     *     Apps/services take precedence over addons; the config schema
     *     enforces name uniqueness across all three pools.
     */
    applyTemplates(
        values: Record<string, string>,
        apps: AppConfig[],
        services: ServiceConfig[],
        _namespace: string,
        context: ContextVariables,
        publicUrlInfo: PublicUrlInfo,
        addonOutputs: AddonOutputs = {},
    ): Record<string, string> {
        const serviceMap = this.buildServiceMap(apps, services, publicUrlInfo);
        const resolved: Record<string, string> = {};

        for (const [key, value] of Object.entries(values)) {
            let result = value;

            result = result.replace(VARIABLE_TEMPLATE_REGEX, (_match, variable: string) => {
                return context[variable as keyof ContextVariables];
            });

            result = result.replace(SERVICE_TEMPLATE_REGEX, (_match, name: string, field: string) => {
                return this.resolveReference(name, field, key, serviceMap, addonOutputs);
            });

            resolved[key] = result;
        }

        return resolved;
    }

    /**
     * Looks up `{{name.field}}` against the three sources. Apps/services
     * win (their field set is constrained to host/port/url); if the name
     * is not in the service map, falls back to addon outputs where the
     * key is provider-defined. Throws with a list of available names
     * when nothing matches.
     */
    private resolveReference(
        name: string,
        field: string,
        sourceKey: string,
        serviceMap: ServiceMap,
        addonOutputs: AddonOutputs,
    ): string {
        const svc = serviceMap[name];
        if (svc != null) {
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
            if (field === "port") return String(svc.port);
            throw new Error(
                `{{${name}.${field}}} in ${sourceKey}: only host/port/url are supported for apps and services. ` +
                    `If "${name}" is meant to be an addon, declare it under \`addons:\` in the preview config.`,
            );
        }

        const outputs = addonOutputs[name];
        if (outputs != null) {
            const value = outputs[field];
            if (value == null) {
                const available = Object.keys(outputs).sort().join(", ") || "(none)";
                throw new Error(
                    `{{${name}.${field}}} in ${sourceKey}: addon "${name}" has no output named "${field}". ` +
                        `Available outputs: ${available}.`,
                );
            }
            return value;
        }

        const names = [...Object.keys(serviceMap), ...Object.keys(addonOutputs)].sort().join(", ");
        throw new Error(
            `Unknown reference "{{${name}.${field}}}" in ${sourceKey}. Available names: ${names || "(none)"}.`,
        );
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
