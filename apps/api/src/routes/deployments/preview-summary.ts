import type { PreviewkitAppStatus, Prisma, PreviewkitStatus } from "@autonoma/db";

type PreviewEnvironmentStatus =
    | "ready"
    | "building"
    | "degraded"
    | "failed"
    | "stopped"
    | "missing"
    | "stale"
    | "unknown";
type PreviewServiceStatus = "ready" | "building" | "failed" | "fallback" | "stopped" | "unknown";
type PreviewServiceKind = "web" | "api" | "worker" | "database" | "service" | "unknown";
type PreviewServiceIconKey =
    | "web"
    | "api"
    | "worker"
    | "node"
    | "postgres"
    | "redis"
    | "valkey"
    | "mongodb"
    | "temporal"
    | "api-gateway"
    | "aws"
    | "docker-image"
    | "upstash"
    | "database"
    | "cache"
    | "service"
    | "unknown";

type PreviewkitAppBuildOutcome =
    | { status: "success"; imageTag: string; durationMs: number; logUrl: string; runtime?: PreviewServiceIconKey }
    | { status: "failed"; durationMs: number; error: string; logUrl?: string; runtime?: PreviewServiceIconKey };

type PreviewkitManifest = {
    apps?: Array<{ name: string; port?: number | null; primary?: boolean | null }>;
    services?: Array<{ name: string; recipe?: string | null; version?: string | null }>;
    addons?: Array<{ name: string; provider?: string | null }>;
};

type PreviewServiceSummary = {
    name: string;
    kind: PreviewServiceKind;
    iconKey: PreviewServiceIconKey;
    status: PreviewServiceStatus;
    branch: string | null;
    branchSource: "matched_pr_branch" | "fallback_default_branch" | "seeded_ephemeral" | "manual_override" | "unknown";
    branchHint: string | null;
    endpoint: string | null;
    port: number | null;
    imageTag: string | null;
    buildLogUrl: string | null;
    statusReason: string | null;
    lastBuiltAt: Date | null;
    lastDeployedAt: Date | null;
};

export function missingPreviewSummary(headSha: string | null, reason: string) {
    return {
        source: "none" as const,
        status: "missing" as const,
        primaryUrl: null,
        phase: null,
        error: reason,
        headSha,
        lastDeployedSha: null,
        updatedAt: null,
        deployedAt: null,
        serviceCount: 0,
        readyServiceCount: 0,
        degradedServiceCount: 0,
        failedServiceCount: 0,
        services: emptyPreviewServices(),
        latestBuild: null,
        actions: {
            openPreview: {
                enabled: false,
                href: null,
                reason: "No preview URL is available.",
            },
        },
    };
}

export function legacyPreviewSummary({
    headSha,
    url,
    updatedAt,
    deployedAt,
}: {
    headSha: string | null;
    url: string;
    updatedAt: Date;
    deployedAt: Date;
}) {
    return {
        source: "legacy" as const,
        status: "ready" as const,
        primaryUrl: url,
        phase: null,
        error: null,
        headSha,
        lastDeployedSha: headSha,
        updatedAt,
        deployedAt,
        serviceCount: 0,
        readyServiceCount: 0,
        degradedServiceCount: 0,
        failedServiceCount: 0,
        services: emptyPreviewServices(),
        latestBuild: null,
        actions: {
            openPreview: {
                enabled: true,
                href: url,
                reason: null,
            },
        },
    };
}

function emptyPreviewServices(): PreviewServiceSummary[] {
    return [];
}

export function buildServiceSummaries({
    branchName,
    environment,
    manifest,
    latestBuild,
    appBuilds,
}: {
    branchName: string;
    environment: {
        status: PreviewkitStatus;
        phase: string | null;
        deployedAt: Date | null;
        appInstances: Array<{
            appName: string;
            status: PreviewkitAppStatus;
            imageTag: string | null;
            error: string | null;
            url: string | null;
            port: number;
            updatedAt: Date;
        }>;
        addons: Array<{
            name: string;
            provider: string;
            status: "pending" | "ok" | "failed" | "deprovisioned";
            error: string | null;
            outputs: Prisma.JsonValue;
            provisionedAt: Date | null;
            updatedAt: Date;
        }>;
    };
    manifest: PreviewkitManifest;
    latestBuild: {
        finishedAt: Date | null;
    } | null;
    appBuilds: Record<string, PreviewkitAppBuildOutcome>;
}): PreviewServiceSummary[] {
    const appInstancesByName = new Map(environment.appInstances.map((app) => [app.appName, app]));
    const appNames = new Set([
        ...(manifest.apps ?? []).map((app) => app.name),
        ...environment.appInstances.map((app) => app.appName),
        ...Object.keys(appBuilds),
    ]);

    const apps = [...appNames].sort().map((name) => {
        const instance = appInstancesByName.get(name);
        const manifestApp = manifest.apps?.find((app) => app.name === name);
        const build = appBuilds[name];
        const kind = inferServiceKind(name);
        return {
            name,
            kind,
            iconKey: resolvePreviewServiceIconKey({ name, kind, runtime: build?.runtime }),
            status: deriveAppStatus(environment.status, instance, build),
            branch: branchName,
            branchSource: "matched_pr_branch" as const,
            branchHint: "matched PR branch",
            endpoint: instance?.url ?? null,
            port: instance?.port ?? manifestApp?.port ?? null,
            imageTag: instance?.imageTag ?? (build?.status === "success" ? build.imageTag : null),
            buildLogUrl: build?.logUrl ?? null,
            statusReason: build?.status === "failed" ? build.error : (instance?.error ?? null),
            lastBuiltAt: latestBuild?.finishedAt ?? null,
            lastDeployedAt: instance?.updatedAt ?? environment.deployedAt,
        } satisfies PreviewServiceSummary;
    });

    const persistedAddons = new Map(environment.addons.map((addon) => [addon.name, addon]));
    const addonNames = new Set([
        ...(manifest.addons ?? []).map((addon) => addon.name),
        ...environment.addons.map((addon) => addon.name),
    ]);
    const addons = [...addonNames].sort().map((name) => {
        const addon = persistedAddons.get(name);
        const manifestAddon = manifest.addons?.find((entry) => entry.name === name);
        const provider = addon?.provider ?? manifestAddon?.provider ?? null;
        const kind = inferAddonKind(provider);
        return {
            name,
            kind,
            iconKey: resolvePreviewServiceIconKey({ name, kind, provider }),
            status: mapAddonStatus(addon?.status),
            branch: null,
            branchSource: "unknown" as const,
            branchHint: addon?.provider != null ? addon.provider : (manifestAddon?.provider ?? null),
            endpoint: safeAddonEndpoint(addon?.outputs),
            port: null,
            imageTag: null,
            buildLogUrl: null,
            statusReason: addon?.error ?? null,
            lastBuiltAt: null,
            lastDeployedAt: addon?.provisionedAt ?? addon?.updatedAt ?? null,
        } satisfies PreviewServiceSummary;
    });

    const genericServices = (manifest.services ?? []).map((service) => {
        const kind = inferRecipeKind(service.recipe ?? service.name);
        return {
            name: service.name,
            kind,
            iconKey: resolvePreviewServiceIconKey({ name: service.name, kind, recipe: service.recipe }),
            status:
                environment.status === "torn_down" ? "stopped" : environment.status === "ready" ? "ready" : "unknown",
            branch: null,
            branchSource: "unknown",
            branchHint:
                service.recipe != null
                    ? `${service.recipe}${service.version != null ? `:${service.version}` : ""}`
                    : null,
            endpoint: null,
            port: null,
            imageTag: null,
            buildLogUrl: null,
            statusReason: null,
            lastBuiltAt: null,
            lastDeployedAt: environment.deployedAt,
        } satisfies PreviewServiceSummary;
    });

    return [...apps, ...genericServices, ...addons];
}

export function derivePreviewStatus({
    previewkitStatus,
    currentHeadSha,
    deployedHeadSha,
    primaryUrl,
    failedServiceCount,
    degradedServiceCount,
}: {
    previewkitStatus: PreviewkitStatus;
    currentHeadSha: string | null;
    deployedHeadSha: string;
    primaryUrl: string | null;
    failedServiceCount: number;
    degradedServiceCount: number;
}): PreviewEnvironmentStatus {
    if (previewkitStatus === "torn_down") return "stopped";
    if (currentHeadSha != null && currentHeadSha !== "" && currentHeadSha !== deployedHeadSha) return "stale";
    if (previewkitStatus === "pending" || previewkitStatus === "building" || previewkitStatus === "deploying") {
        return "building";
    }
    if (previewkitStatus === "failed") return primaryUrl != null ? "degraded" : "failed";
    if (previewkitStatus === "ready") {
        if (failedServiceCount > 0 || degradedServiceCount > 0) return "degraded";
        return "ready";
    }
    return "unknown";
}

function deriveAppStatus(
    environmentStatus: PreviewkitStatus,
    instance: { status: PreviewkitAppStatus } | undefined,
    build: PreviewkitAppBuildOutcome | undefined,
): PreviewServiceStatus {
    if (environmentStatus === "torn_down") return "stopped";
    // The per-app lifecycle row is the source of truth once it exists.
    if (instance != null) return mapAppStatus(instance.status);
    // No per-app row yet (config not resolved, or a service/addon handled
    // elsewhere): fall back to the build outcome and the env-level status.
    if (build?.status === "failed") return "failed";
    if (environmentStatus === "pending" || environmentStatus === "building" || environmentStatus === "deploying")
        return "building";
    if (environmentStatus === "failed") return "failed";
    return "unknown";
}

function mapAppStatus(status: PreviewkitAppStatus): PreviewServiceStatus {
    if (status === "ready") return "ready";
    if (status === "build_failed" || status === "deploy_failed" || status === "skipped") return "failed";
    // pending | building | built | deploying are all in-flight.
    return "building";
}

function mapAddonStatus(status: "pending" | "ok" | "failed" | "deprovisioned" | undefined): PreviewServiceStatus {
    if (status === "ok") return "ready";
    if (status === "pending") return "building";
    if (status === "failed") return "failed";
    if (status === "deprovisioned") return "stopped";
    return "unknown";
}

export function mapBuildStatus(status: PreviewkitStatus): "ready" | "building" | "failed" | "unknown" {
    if (status === "ready") return "ready";
    if (status === "failed") return "failed";
    if (status === "pending" || status === "building" || status === "deploying") return "building";
    return "unknown";
}

export function parseManifest(value: Prisma.JsonValue): PreviewkitManifest {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    return {
        apps: Array.isArray(record.apps)
            ? record.apps
                  .filter(isNamedRecord)
                  .map((app) => ({ name: app.name, port: toNumber(app.port), primary: toBoolean(app.primary) }))
            : [],
        services: Array.isArray(record.services)
            ? record.services.filter(isNamedRecord).map((service) => ({
                  name: service.name,
                  recipe: toStringOrNull(service.recipe),
                  version: toStringOrNull(service.version),
              }))
            : [],
        addons: Array.isArray(record.addons)
            ? record.addons.filter(isNamedRecord).map((addon) => ({
                  name: addon.name,
                  provider: toStringOrNull(addon.provider),
              }))
            : [],
    };
}

export function parseStringRecord(value: Prisma.JsonValue): Record<string, string> {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
            .sort(([a], [b]) => a.localeCompare(b)),
    );
}

/** One persisted `PreviewkitAppBuild` row, as selected by the deployments query. */
type AppBuildRow = {
    appName: string;
    status: "success" | "failed";
    imageTag: string | null;
    durationMs: number;
    logUrl: string | null;
    error: string | null;
    runtime: string | null;
};

export function toAppBuildOutcomeMap(rows: AppBuildRow[]): Record<string, PreviewkitAppBuildOutcome> {
    const result: Record<string, PreviewkitAppBuildOutcome> = {};
    for (const row of rows) {
        const runtime = toIconKeyOrUndefined(row.runtime);
        if (row.status === "success") {
            const outcome: PreviewkitAppBuildOutcome = {
                status: "success",
                imageTag: row.imageTag ?? "",
                durationMs: row.durationMs,
                logUrl: row.logUrl ?? "",
            };
            if (runtime != null) outcome.runtime = runtime;
            result[row.appName] = outcome;
            continue;
        }
        const outcome: PreviewkitAppBuildOutcome = {
            status: "failed",
            durationMs: row.durationMs,
            error: row.error ?? "Build failed",
        };
        if (row.logUrl != null) outcome.logUrl = row.logUrl;
        if (runtime != null) outcome.runtime = runtime;
        result[row.appName] = outcome;
    }
    return result;
}

export function resolvePrimaryUrl(manifest: PreviewkitManifest, urls: Record<string, string>): string | null {
    const primaryAppName = manifest.apps?.find((app) => app.primary === true)?.name;
    if (primaryAppName != null && urls[primaryAppName] != null) return urls[primaryAppName];
    const firstManifestUrl = manifest.apps
        ?.map((app) => urls[app.name])
        .find((url): url is string => url != null && url !== "");
    if (firstManifestUrl != null) return firstManifestUrl;
    return Object.values(urls)[0] ?? null;
}

function safeAddonEndpoint(value: Prisma.JsonValue | undefined): string | null {
    if (value == null) return null;
    const outputs = parseStringRecord(value);
    return outputs.url ?? outputs.host ?? null;
}

function inferServiceKind(name: string): PreviewServiceKind {
    const normalized = name.toLowerCase();
    if (normalized.includes("worker")) return "worker";
    if (normalized.includes("api")) return "api";
    if (normalized.includes("web") || normalized.includes("frontend") || normalized.includes("app")) return "web";
    return "service";
}

function inferRecipeKind(value: string): PreviewServiceKind {
    const normalized = value.toLowerCase();
    if (normalized.includes("postgres") || normalized.includes("mongo") || normalized.includes("db")) return "database";
    if (normalized.includes("worker")) return "worker";
    if (normalized.includes("api")) return "api";
    return "service";
}

function inferAddonKind(provider: string | null): PreviewServiceKind {
    if (provider == null) return "service";
    return inferRecipeKind(provider);
}

function resolvePreviewServiceIconKey({
    name,
    kind,
    runtime,
    recipe,
    provider,
}: {
    name: string;
    kind: PreviewServiceKind;
    runtime?: PreviewServiceIconKey | undefined;
    recipe?: string | null | undefined;
    provider?: string | null | undefined;
}): PreviewServiceIconKey {
    if (runtime != null && runtime !== "unknown") return runtime;

    const recipeIcon = recipe != null ? iconKeyFromToken(recipe) : undefined;
    if (recipeIcon != null) return recipeIcon;

    const providerIcon = provider != null ? iconKeyFromToken(provider) : undefined;
    if (providerIcon != null) return providerIcon;

    const nameIcon = iconKeyFromToken(name);
    if (nameIcon != null) return nameIcon;

    return iconKeyFromKind(kind);
}

function iconKeyFromToken(value: string): PreviewServiceIconKey | undefined {
    const normalized = value.toLowerCase();
    if (normalized.includes("postgres") || normalized === "pg" || normalized.includes("neon")) return "postgres";
    if (normalized.includes("mongodb") || normalized.includes("mongo")) return "mongodb";
    if (normalized.includes("valkey")) return "valkey";
    if (normalized.includes("redis")) return "redis";
    if (normalized.includes("upstash")) return "upstash";
    if (normalized.includes("temporal")) return "temporal";
    if (normalized.includes("api-gateway") || normalized.includes("gateway")) return "api-gateway";
    if (normalized.includes("docker-image") || normalized.includes("docker")) return "docker-image";
    if (normalized.includes("nodejs") || normalized === "node" || normalized.includes("node-")) return "node";
    if (normalized === "aws" || normalized.includes("localstack") || normalized.includes("s3")) return "aws";
    if (normalized.includes("worker")) return "worker";
    if (normalized.includes("api")) return "api";
    if (normalized.includes("web") || normalized.includes("frontend")) return "web";
    if (normalized === "db" || normalized.includes("database")) return "database";
    if (normalized === "cache" || normalized.includes("cache")) return "cache";
    return undefined;
}

function iconKeyFromKind(kind: PreviewServiceKind): PreviewServiceIconKey {
    if (kind === "database") return "database";
    if (kind === "web") return "web";
    if (kind === "api") return "api";
    if (kind === "worker") return "worker";
    if (kind === "unknown") return "unknown";
    return "service";
}

function toIconKeyOrUndefined(value: unknown): PreviewServiceIconKey | undefined {
    if (typeof value !== "string") return undefined;
    const iconKey = iconKeyFromToken(value);
    return iconKey ?? iconKeyFromExactValue(value);
}

function iconKeyFromExactValue(value: string): PreviewServiceIconKey | undefined {
    if (
        value === "web" ||
        value === "api" ||
        value === "worker" ||
        value === "node" ||
        value === "postgres" ||
        value === "redis" ||
        value === "valkey" ||
        value === "mongodb" ||
        value === "temporal" ||
        value === "api-gateway" ||
        value === "aws" ||
        value === "docker-image" ||
        value === "upstash" ||
        value === "database" ||
        value === "cache" ||
        value === "service" ||
        value === "unknown"
    ) {
        return value;
    }
    return undefined;
}

function isNamedRecord(value: unknown): value is Record<string, unknown> & { name: string } {
    return (
        value != null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as { name?: unknown }).name === "string"
    );
}

function toStringOrNull(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

function toNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toBoolean(value: unknown): boolean | null {
    return typeof value === "boolean" ? value : null;
}
