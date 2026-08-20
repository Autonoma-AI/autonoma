import type {
    BranchConvention,
    ContainerResources,
    DatabaseSetupTask,
    HookGroupKey,
    PreviewConfig,
} from "./previewkit-config";
import { PREVIEW_CONFIG_VERSION } from "./previewkit-config";
import {
    APP_RESOURCE_TIERS,
    appResourceTierOrDefault,
    type AppResourceTier,
    SERVICE_RESOURCE_TIERS,
    serviceResourceTierOrDefault,
    type ServiceResourceTier,
} from "./previewkit-resource-tiers";

/**
 * The codec between a preview config document and the normalized rows that store
 * it. The document stays the domain and wire contract everywhere (tRPC, MCP, the
 * deploy pipeline, and the `resolvedConfig` deploy snapshots); only storage is
 * relational, so every reader composes a document from rows and validates it at
 * its own boundary.
 *
 * Pure and dependency-free on purpose: the row types below are structural
 * mirrors of the Prisma models, so `@autonoma/db` results satisfy them without
 * this package depending on the client.
 *
 * Two rules hold the round trip together:
 * - Decompose PARSE OUTPUT only. Stored documents are already
 *   defaults-materialized (`path`, `build_secrets`, `resources`, ...), so the
 *   columns are non-nullable and composition never has to re-apply a default.
 * - A null column composes to an ABSENT key, never `null` - except where a null
 *   means the row is malformed, which is passed through so the reader's schema
 *   rejects it loudly rather than papering over it.
 *
 * The one lossy field is `depends_on`: it is optional with no default, and a
 * Postgres array cannot tell absent from empty. It composes back only when
 * non-empty, which every consumer already reads as `depends_on ?? []`.
 */

export type PreviewkitBranchConventionType = BranchConvention["type"];
export type PreviewkitSetupTaskFrequency = DatabaseSetupTask["frequency"];

export interface PreviewkitConfigRepositoryRow {
    position: number;
    repo: string;
    fallbackBranch: string;
    sha: string | null;
}

export interface PreviewkitConfigConnectionRow {
    position: number;
    key: string;
    value: string;
    buildTime: boolean;
}

export interface PreviewkitConfigAppRow {
    /**
     * Optional because the codec composes whatever it is handed: a stored row always
     * carries an id, a synthesized one need not, and a document composed without one
     * simply omits the field.
     */
    id?: string;
    position: number;
    name: string;
    repository: string;
    path: string;
    buildContext: string | null;
    dockerfile: string | null;
    build: unknown;
    blueprint: unknown;
    buildSecrets: string[];
    port: number;
    command: string | null;
    healthCheck: string | null;
    primary: boolean | null;
    sdkImplemented: boolean | null;
    sdkPath: string | null;
    resourcesTier: AppResourceTier;
    dependsOn: string[];
    connections: PreviewkitConfigConnectionRow[];
}

export interface PreviewkitConfigSetupTaskRow {
    position: number;
    command: string;
    frequency: PreviewkitSetupTaskFrequency;
    location: unknown;
}

export interface PreviewkitConfigServiceRow {
    position: number;
    name: string;
    recipe: string;
    version: string | null;
    options: unknown;
    resourcesTier: ServiceResourceTier;
    s3: boolean | null;
    sqs: boolean | null;
    sns: boolean | null;
    setupTasks: PreviewkitConfigSetupTaskRow[];
}

export interface PreviewkitConfigHookRow {
    group: HookGroupKey;
    position: number;
    app: string;
    command: string;
}

/** A `PreviewkitConfig` row with its topology children, as the DB returns them. */
export interface PreviewkitConfigRows {
    domain: string | null;
    registry: string | null;
    branchConventionType: PreviewkitBranchConventionType | null;
    branchConventionPattern: string | null;
    branchConventionReplacement: string | null;
    repositories: PreviewkitConfigRepositoryRow[];
    apps: PreviewkitConfigAppRow[];
    services: PreviewkitConfigServiceRow[];
    hooks: PreviewkitConfigHookRow[];
}

export interface PreviewkitConfigRepositoryValues {
    position: number;
    repo: string;
    fallbackBranch: string;
    sha?: string;
}

export interface PreviewkitConfigConnectionValues {
    position: number;
    key: string;
    value: string;
    buildTime: boolean;
}

export interface PreviewkitConfigAppValues {
    position: number;
    name: string;
    repository: string;
    path: string;
    buildContext?: string;
    dockerfile?: string;
    build?: PreviewConfig["apps"][number]["build"];
    blueprint?: PreviewConfig["apps"][number]["blueprint"];
    buildSecrets: string[];
    port: number;
    command?: string;
    healthCheck?: string;
    primary?: boolean;
    sdkImplemented?: boolean;
    sdkPath?: string;
    resourcesTier: AppResourceTier;
    dependsOn: string[];
    connections: PreviewkitConfigConnectionValues[];
}

export interface PreviewkitConfigSetupTaskValues {
    position: number;
    command: string;
    frequency: PreviewkitSetupTaskFrequency;
    location: DatabaseSetupTask["location"];
}

export interface PreviewkitConfigServiceValues {
    position: number;
    name: string;
    recipe: string;
    version?: string;
    options: Record<string, unknown>;
    resourcesTier: ServiceResourceTier;
    s3?: boolean;
    sqs?: boolean;
    sns?: boolean;
    setupTasks: PreviewkitConfigSetupTaskValues[];
}

export interface PreviewkitConfigHookValues {
    group: HookGroupKey;
    position: number;
    app: string;
    command: string;
}

/** Everything a document decomposes into: the parent's own columns plus its children. */
export interface PreviewkitConfigRowValues {
    domain?: string;
    registry?: string;
    branchConventionType?: PreviewkitBranchConventionType;
    branchConventionPattern?: string;
    branchConventionReplacement?: string;
    repositories: PreviewkitConfigRepositoryValues[];
    apps: PreviewkitConfigAppValues[];
    services: PreviewkitConfigServiceValues[];
    hooks: PreviewkitConfigHookValues[];
}

/**
 * Composes the config document held by a `PreviewkitConfig` row and its children.
 *
 * Returns it UNVALIDATED: each caller parses with the schema variant its trust
 * level calls for (`trustedPreviewConfigSchema` for stored/platform config,
 * `previewConfigSchema` for anything shown back to a client) and keeps its own
 * failure behavior.
 */
export function documentFromPreviewkitConfigRows(rows: PreviewkitConfigRows): Record<string, unknown> {
    return {
        version: PREVIEW_CONFIG_VERSION,
        domain: rows.domain ?? undefined,
        registry: rows.registry ?? undefined,
        repositories: byPosition(rows.repositories).map((repository) => ({
            repo: repository.repo,
            fallback_branch: repository.fallbackBranch,
            sha: repository.sha ?? undefined,
        })),
        branch_convention: branchConventionFromRows(rows),
        apps: byPosition(rows.apps).map(appFromRow),
        services: byPosition(rows.services).map(serviceFromRow),
        hooks: {
            pre_deploy: hookStepsFromRows(rows.hooks, "pre_deploy"),
            post_deploy: hookStepsFromRows(rows.hooks, "post_deploy"),
        },
    };
}

/**
 * Decomposes a document into rows. Takes PARSE OUTPUT (a `PreviewConfig`), never a
 * raw stored document: the schema is what materializes the defaults the columns
 * rely on, and - for a document written before the current schema - what upgrades
 * it. Array order is preserved as `position`, since hook order is execution order
 * and app order feeds the editor and the primary-app fallback.
 */
export function previewkitConfigRowValues(config: PreviewConfig): PreviewkitConfigRowValues {
    const convention = config.branch_convention;
    const regexConvention = convention?.type === "regex" ? convention : undefined;

    return {
        domain: config.domain,
        registry: config.registry,
        branchConventionType: convention?.type,
        branchConventionPattern: regexConvention?.pattern,
        branchConventionReplacement: regexConvention?.replacement,
        repositories: config.repositories.map((repository, position) => ({
            position,
            repo: repository.repo,
            fallbackBranch: repository.fallback_branch,
            sha: repository.sha,
        })),
        apps: config.apps.map(appValues),
        services: config.services.map(serviceValues),
        hooks: [
            ...hookValues(config.hooks.pre_deploy, "pre_deploy"),
            ...hookValues(config.hooks.post_deploy, "post_deploy"),
        ],
    };
}

function appFromRow(app: PreviewkitConfigAppRow): Record<string, unknown> {
    return {
        id: app.id,
        name: app.name,
        repository: app.repository,
        path: app.path,
        build_context: app.buildContext ?? undefined,
        dockerfile: app.dockerfile ?? undefined,
        build: app.build ?? undefined,
        blueprint: app.blueprint ?? undefined,
        build_secrets: app.buildSecrets,
        port: app.port,
        connections: byPosition(app.connections).map((connection) => ({
            key: connection.key,
            value: connection.value,
            build_time: connection.buildTime,
        })),
        command: app.command ?? undefined,
        health_check: app.healthCheck ?? undefined,
        primary: app.primary ?? undefined,
        sdk_implemented: app.sdkImplemented ?? undefined,
        sdk_path: app.sdkPath ?? undefined,
        resources: appResourcesFromRow(app),
        depends_on: app.dependsOn.length > 0 ? app.dependsOn : undefined,
    };
}

function serviceFromRow(service: PreviewkitConfigServiceRow): Record<string, unknown> {
    return {
        name: service.name,
        recipe: service.recipe,
        version: service.version ?? undefined,
        options: service.options,
        setup_tasks: byPosition(service.setupTasks).map((task) => ({
            command: task.command,
            frequency: task.frequency,
            location: task.location,
        })),
        resources: serviceResourcesFromRow(service),
        s3: service.s3 ?? undefined,
        sqs: service.sqs ?? undefined,
        sns: service.sns ?? undefined,
    };
}

/**
 * A convention with no type is absent. A `regex` one passes its pattern and
 * replacement through even when null, so a half-written row fails the reader's
 * validation instead of quietly becoming an empty pattern that matches everything.
 */
function branchConventionFromRows(rows: PreviewkitConfigRows): Record<string, unknown> | undefined {
    const type = rows.branchConventionType;
    if (type == null) return undefined;
    if (type !== "regex") return { type };

    return {
        type,
        pattern: rows.branchConventionPattern,
        replacement: rows.branchConventionReplacement,
    };
}

function hookStepsFromRows(hooks: PreviewkitConfigHookRow[], group: HookGroupKey) {
    return byPosition(hooks.filter((hook) => hook.group === group)).map((hook) => ({
        app: hook.app,
        command: hook.command,
    }));
}

function appResourcesFromRow(row: { resourcesTier: string }): ContainerResources {
    const tier = appResourceTierOrDefault(row.resourcesTier);
    return { tier, ...APP_RESOURCE_TIERS[tier] };
}

function serviceResourcesFromRow(row: { resourcesTier: string }): ContainerResources {
    const tier = serviceResourceTierOrDefault(row.resourcesTier);
    return { tier, ...SERVICE_RESOURCE_TIERS[tier] };
}

function appValues(app: PreviewConfig["apps"][number], position: number): PreviewkitConfigAppValues {
    return {
        position,
        name: app.name,
        repository: app.repository,
        path: app.path,
        buildContext: app.build_context,
        dockerfile: app.dockerfile,
        build: app.build,
        blueprint: app.blueprint,
        buildSecrets: app.build_secrets,
        port: app.port,
        command: app.command,
        healthCheck: app.health_check,
        primary: app.primary,
        sdkImplemented: app.sdk_implemented,
        sdkPath: app.sdk_path,
        resourcesTier: appResourceTierOrDefault(app.resources.tier),
        dependsOn: app.depends_on ?? [],
        connections: app.connections.map((connection, connectionPosition) => ({
            position: connectionPosition,
            key: connection.key,
            value: connection.value,
            buildTime: connection.build_time,
        })),
    };
}

function serviceValues(service: PreviewConfig["services"][number], position: number): PreviewkitConfigServiceValues {
    return {
        position,
        name: service.name,
        recipe: service.recipe,
        version: service.version,
        options: service.options,
        resourcesTier: serviceResourceTierOrDefault(service.resources.tier),
        s3: service.s3,
        sqs: service.sqs,
        sns: service.sns,
        setupTasks: service.setup_tasks.map((task, taskPosition) => ({
            position: taskPosition,
            command: task.command,
            frequency: task.frequency,
            location: task.location,
        })),
    };
}

function hookValues(steps: PreviewConfig["hooks"]["pre_deploy"], group: HookGroupKey): PreviewkitConfigHookValues[] {
    return steps.map((step, position) => ({
        group,
        position,
        app: step.app,
        command: step.command,
    }));
}

/**
 * Sorts by `position` rather than trusting the query's `orderBy`, so a caller that
 * hand-rolls an include cannot silently scramble hook execution order.
 */
function byPosition<T extends { position: number }>(rows: T[]): T[] {
    return [...rows].sort((left, right) => left.position - right.position);
}
