import {
    hasConnectionToken,
    isPreviewkitDatabaseEngine,
    PREVIEWKIT_RUNTIME_CATALOG,
    validateHookSteps,
    type Build,
    type ConfigIssue,
    type HookGroupKey,
    type PreviewConfig,
    type PreviewkitRuntime,
} from "@autonoma/types";

/** The runtime a fresh app starts on (Manual is the default build method). */
const DEFAULT_RUNTIME: PreviewkitRuntime = "node";
import { z } from "zod";

export const PRIMARY_REPO_KEY = "primary";

export type ServiceRecipe =
    | "postgres"
    | "mysql"
    | "redis"
    | "valkey"
    | "temporal"
    | "mongodb"
    | "upstash"
    | "docker-image";

export const SERVICE_OPTIONS: Array<{
    recipe: ServiceRecipe;
    label: string;
    defaultName: string;
    version?: string;
    meta: string;
    /** The fixed container port the recipe listens on ({{name.port}}); custom images define their own. */
    defaultPort?: number;
}> = [
    { recipe: "postgres", label: "Postgres", defaultName: "db", version: "16", meta: "16 · 5432", defaultPort: 5432 },
    { recipe: "mysql", label: "MySQL", defaultName: "db", version: "8", meta: "8 · 3306", defaultPort: 3306 },
    { recipe: "redis", label: "Redis", defaultName: "cache", version: "7", meta: "7 · 6379", defaultPort: 6379 },
    { recipe: "valkey", label: "Valkey", defaultName: "valkey", version: "7", meta: "7 · 6379", defaultPort: 6379 },
    { recipe: "mongodb", label: "MongoDB", defaultName: "mongo", version: "7", meta: "7 · 27017", defaultPort: 27017 },
    { recipe: "upstash", label: "Upstash", defaultName: "upstash", meta: "· 8000", defaultPort: 8000 },
    { recipe: "temporal", label: "Temporal", defaultName: "temporal", meta: "· 7233", defaultPort: 7233 },
    { recipe: "docker-image", label: "Docker image", defaultName: "container", meta: "custom image" },
];

/**
 * Recipes whose container comes from a user-supplied image rather than a fixed
 * catalog image. These expose the full custom-image option set (image, port,
 * extra ports, command/args, readiness probe - compiled into the service
 * `options` block) and hide the catalog `version`, which has no meaning for an
 * arbitrary container.
 */
export function serviceRecipeUsesCustomImage(recipe: ServiceRecipe): boolean {
    return recipe === "docker-image";
}

/**
 * Whether a recipe is a database engine - the ones surfaced in the onboarding
 * Database step (postgres, mysql, mongodb, redis, valkey). Everything else
 * (docker-image, and legacy upstash/temporal) is an "extra service". Mirrors
 * {@link isPreviewkitDatabaseEngine} in `@autonoma/types`.
 */
export function serviceRecipeIsDatabase(recipe: ServiceRecipe): boolean {
    return isPreviewkitDatabaseEngine(recipe);
}

/**
 * Whether a service recipe resolves `{{<name>.url}}` to an in-cluster
 * connection string at deploy time (postgres -> `postgresql://…`,
 * mysql -> `mysql://…`, redis/valkey -> `redis://…`,
 * mongodb -> `mongodb://…?directConnection=true`). Temporal speaks gRPC with no
 * single-scheme URL, and Upstash exposes both a REST and a RESP endpoint with no
 * single canonical URL, so only `{{<name>.host}}`/`{{<name>.port}}` are offered
 * for those. Mirrors the recipe `connectionInfo.url` support in apps/previewkit.
 */
export function serviceRecipeSupportsUrlToken(recipe: ServiceRecipe): boolean {
    return (
        recipe === "postgres" || recipe === "mysql" || recipe === "redis" || recipe === "valkey" || recipe === "mongodb"
    );
}

/** Where an env/secret row came from on load, so a save can diff secret changes. */
export type EnvRowOrigin = "config" | "secret" | "new";

/**
 * One variable of an app. Every variable is either:
 *   - a secret (`sensitive: true`): a user-typed value stored in AWS Secrets
 *     Manager and injected via `envFrom`. Its value is write-only.
 *   - a connection (`sensitive: false`): a `{{target.property}}` binding to
 *     another app/service, resolved at deploy time (compiles to `connections`).
 * `buildTime` mirrors the value into the image build (a secret key becomes a
 * `build_secrets` entry; a connection gets `build_time: true`).
 */
export interface EnvRowDraft {
    id: number;
    key: string;
    value: string;
    sensitive: boolean;
    buildTime: boolean;
    origin: EnvRowOrigin;
}

export function envRow(
    key: string,
    value: string,
    sensitive = false,
    origin: EnvRowOrigin = "new",
    buildTime = false,
): EnvRowDraft {
    return { id: nextDraftId(), key, value, sensitive, buildTime, origin };
}

export type AppDraftOrigin = "saved" | "manual";

/**
 * How an app's image is built (the three choices the app-card selector exposes):
 * - `auto` - previewkit autodetects (Railpack / on-disk Dockerfile). If the app
 *   loaded with a framework-preset `build` block the selector can't model, that
 *   block is kept verbatim in {@link AppDraft.buildPassthrough} and re-emitted, so
 *   a save never silently downgrades a preset to autodetection.
 * - `dockerfile` - the app's `dockerfile` path is built.
 * - `runtime` - the manual escape hatch: pick a runtime + write a bash build
 *   script and entrypoint; compiles to a `build: { framework: "runtime", ... }`.
 */
export type AppBuildMode = "auto" | "dockerfile" | "runtime";

export interface AppDraft {
    id: number;
    /** `PRIMARY_REPO_KEY` or a dependency repo alias (`RepoDraft.name`). */
    repoKey: string;
    name: string;
    path: string;
    buildContext: string;
    buildMode: AppBuildMode;
    dockerfile: string;
    /**
     * A non-runtime `build` block (a framework preset like node/next/vite/bun, or
     * an explicit dockerfile build block) the app loaded with that the three-way
     * selector cannot represent. Kept verbatim so an edit+save re-emits it instead
     * of dropping it to autodetection. Cleared the moment the user picks a build
     * mode. Present only when `buildMode === "auto"`.
     */
    buildPassthrough?: Build;
    /** Manual-runtime selection (used when `buildMode === "runtime"`). Defaults to node. */
    runtime: PreviewkitRuntime;
    /** Raw runtime image version tag; blank uses the catalog default. */
    runtimeVersion: string;
    /** Manual bash build script (optional - some apps need no build step). */
    buildScript: string;
    /** Manual bash entrypoint (the container start command). */
    entrypoint: string;
    port: string;
    command: string;
    healthCheck: string;
    primary: boolean;
    dependsOn: string[];
    /** Unified variable list: secrets (sensitive) and connections (bindings). */
    env: EnvRowDraft[];
    origin: AppDraftOrigin;
}

/** The kind of readiness probe a custom-image service uses, or none. */
export type ServiceReadinessKind = "none" | "http" | "exec" | "tcp";

/**
 * Readiness probe for a custom-image service, mirroring the recipe's `readiness`
 * option (exactly one of http/exec/tcp). All values are strings the form edits;
 * `compileServiceOptions` parses and drops blanks. A blank `port` for http/tcp
 * falls back to the service's primary port at compile time.
 */
export interface ServiceReadinessDraft {
    kind: ServiceReadinessKind;
    /** HTTP probe path (e.g. `/healthz`). */
    httpPath: string;
    /** Port for http/tcp probes; blank means reuse the primary port. */
    port: string;
    /** Exec probe command, one argv token per line. */
    execCommand: string;
    initialDelaySeconds: string;
    periodSeconds: string;
}

export function emptyServiceReadinessDraft(): ServiceReadinessDraft {
    return { kind: "none", httpPath: "", port: "", execCommand: "", initialDelaySeconds: "", periodSeconds: "" };
}

/** Task frequency: run once when the database is first created, or on every deploy. */
export type SetupTaskFrequency = "on_create" | "every_commit";

/** Where a setup task runs: folded into an app's build, or its own throwaway job. */
export type SetupTaskLocationType = "in_build" | "separate_job";

/**
 * One database setup command (schema, seed, or migration) in the editor. Compiles
 * to a `setup_tasks` entry. `app` + `position` apply when `locationType` is
 * `in_build`; `repo` (a dependency-repo alias, blank = the primary repo) applies
 * when `separate_job`. `id` is a stable React key (mirrors {@link ServiceDraft}).
 */
export interface SetupTaskDraft {
    id: number;
    command: string;
    frequency: SetupTaskFrequency;
    locationType: SetupTaskLocationType;
    app: string;
    position: "before" | "after";
    repo: string;
}

export function emptySetupTaskDraft(frequency: SetupTaskFrequency): SetupTaskDraft {
    return {
        id: nextDraftId(),
        command: "",
        frequency,
        locationType: "separate_job",
        app: "",
        position: "after",
        repo: "",
    };
}

/** One plain environment variable of an extra (docker-image) service. */
export interface ServiceEnvDraft {
    id: number;
    key: string;
    value: string;
}

export function serviceEnvRow(key = "", value = ""): ServiceEnvDraft {
    return { id: nextDraftId(), key, value };
}

export interface ServiceDraft {
    id: number;
    recipe: ServiceRecipe;
    name: string;
    version: string;
    /** Guided setup tasks (database recipes only): schema, seed, migrations. */
    setupTasks: SetupTaskDraft[];
    /** Plain environment variables (docker-image extra services only). */
    env: ServiceEnvDraft[];
    /** Container image for custom-image recipes (docker-image). Empty otherwise. */
    image: string;
    /** Primary container port for custom-image recipes (docker-image). Empty otherwise. */
    port: string;
    /** Optional name for the primary port (custom-image only). Empty otherwise. */
    portName: string;
    /** Extra ports for custom-image recipes, one `port` or `name:port` per line. */
    additionalPorts: string;
    /** Container command (entrypoint) override, one argv token per line. */
    command: string;
    /** Container args, one argv token per line. */
    args: string;
    /** Readiness probe (custom-image only). */
    readiness: ServiceReadinessDraft;
    /**
     * Recipe `options` the form does not model (postgres user/database/
     * databases/extensions/ssl/storage/restore_from, and any future keys),
     * preserved verbatim from load so an edit+save round-trips them instead of
     * silently dropping them. For custom-image recipes this excludes the keys
     * the form owns (image/port/command/args/readiness); for every other recipe
     * it is the full options bag.
     */
    optionsPassthrough: Record<string, unknown>;
}

export interface RepoDraft {
    id: number;
    /** Kubernetes-safe alias used in `config.multirepo.repos[].name`. */
    name: string;
    /** Repo full name (`owner/repo`). */
    repo: string;
    fallbackBranch: string;
    githubRepositoryId?: number;
}

export type BranchConventionDraft =
    | { type: "none" }
    | { type: "same_branch_name" }
    | { type: "regex"; pattern: string; replacement: string }
    | { type: "manual" };

/** Lifecycle phase a hook runs in. Mirrors the `hooks` group keys in the config document. */
export type HookGroup = "pre_deploy" | "post_deploy";

/**
 * One deploy hook row in the editor. `id` is a stable React key (mirrors
 * {@link ServiceDraft}). Every hook runs as a one-off Kubernetes Job built from
 * the target app's image, so the row is just the app and the command.
 */
export interface HookDraft {
    id: number;
    app: string;
    command: string;
}

export interface HooksDraft {
    pre_deploy: HookDraft[];
    post_deploy: HookDraft[];
}

/** Document-level fields the form doesn't expose but must survive a round-trip. */
export type DocumentPassthrough = Pick<PreviewConfig, "domain" | "registry" | "addons">;

export interface TopologyDraft {
    apps: AppDraft[];
    services: ServiceDraft[];
    repos: RepoDraft[];
    branchConvention: BranchConventionDraft;
    /** Pre/post-deploy hooks, authored on the primary repo. Empty groups by default. */
    hooks: HooksDraft;
    passthrough: Partial<DocumentPassthrough>;
}

export interface CompiledDocument {
    document: Record<string, unknown>;
    /** Maps `apps[index]` in the compiled document back to the AppDraft id, for error keying. */
    indexToDraftId: Map<number, number>;
}

export interface CompiledTopology {
    primary: CompiledDocument;
    dependencies: Array<CompiledDocument & { alias: string; repo: string }>;
}

let draftIdCounter = 1;

export function nextDraftId(): number {
    draftIdCounter += 1;
    return draftIdCounter;
}

/**
 * Sanitizes a repo name into a Kubernetes-safe alias (`config.multirepo.repos[].name`),
 * suffixing `-2`, `-3`, ... until it is unique among the aliases already in use.
 */
export function repoAliasFrom(name: string, existingAliases: readonly string[]): string {
    const base = name
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const sanitized = base === "" ? "repo" : base;
    const taken = new Set(existingAliases);
    if (!taken.has(sanitized)) return sanitized;
    let suffix = 2;
    while (taken.has(`${sanitized}-${suffix}`)) suffix += 1;
    return `${sanitized}-${suffix}`;
}

export function emptyAppDraft(repoKey: string, origin: AppDraftOrigin = "manual"): AppDraft {
    // A fresh app defaults to Manual mode (auto-detect is no longer a choice),
    // seeded with the default runtime's build script + entrypoint so it is valid
    // out of the box rather than failing on a required-but-empty entrypoint.
    const defaults = PREVIEWKIT_RUNTIME_CATALOG[DEFAULT_RUNTIME];
    return {
        id: nextDraftId(),
        repoKey,
        name: "",
        path: ".",
        buildContext: "",
        buildMode: "runtime",
        dockerfile: "",
        runtime: DEFAULT_RUNTIME,
        runtimeVersion: "",
        buildScript: defaults.defaultBuildScript,
        entrypoint: defaults.defaultEntrypoint,
        port: "",
        command: "",
        healthCheck: "/",
        primary: false,
        dependsOn: [],
        env: [],
        origin,
    };
}

/**
 * Generates a service name unique against `existing` (the current draft service
 * names), starting from `base` and appending `-2`, `-3`, … on collision. Mirrors
 * the unique-name constraint the previewkit schema enforces across
 * apps/services/addons, so a freshly-added instance never immediately collides.
 */
export function uniqueServiceName(base: string, existing: string[]): string {
    const taken = new Set(existing.map((name) => name.trim()).filter((name) => name !== ""));
    if (!taken.has(base)) return base;
    let suffix = 2;
    while (taken.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
}

/**
 * Builds a fresh {@link ServiceDraft} for a recipe, seeding the catalog default
 * name (deduped against `existingNames`) and version. Mirrors
 * {@link emptyAppDraft} so the services picker's add handler stays a one-liner.
 */
export function serviceDraftForRecipe(recipe: ServiceRecipe, existingNames: string[]): ServiceDraft {
    const option = SERVICE_OPTIONS.find((candidate) => candidate.recipe === recipe);
    return {
        id: nextDraftId(),
        recipe,
        name: uniqueServiceName(option?.defaultName ?? recipe, existingNames),
        version: option?.version ?? "",
        setupTasks: [],
        env: [],
        image: "",
        port: "",
        portName: "",
        additionalPorts: "",
        command: "",
        args: "",
        readiness: emptyServiceReadinessDraft(),
        optionsPassthrough: {},
    };
}

/** Hydrates the form draft from the saved primary document plus per-repo dependency documents. */
export function draftFromConfig(
    primary: PreviewConfig,
    dependencies: Array<{ name: string; repo: string; githubRepositoryId?: number; document?: PreviewConfig }>,
    mode: "saved" | "starter" = "saved",
): TopologyDraft {
    const repos: RepoDraft[] = (primary.config?.multirepo?.repos ?? []).map((dep) => {
        const match = dependencies.find((candidate) => candidate.name === dep.name);
        const repoDraft: RepoDraft = {
            id: nextDraftId(),
            name: dep.name,
            repo: dep.repo,
            fallbackBranch: dep.fallback_branch,
        };
        if (match?.githubRepositoryId != null) repoDraft.githubRepositoryId = match.githubRepositoryId;
        return repoDraft;
    });

    // Fresh starter apps are real, editable apps from birth (origin "manual"):
    // they carry a complete seeded build block and are immediately deployable, so
    // there is no separate "untouched starter" state to unlock.
    const apps = primary.apps.map((app) =>
        appDraftFromConfig(app, PRIMARY_REPO_KEY, mode === "starter" ? "manual" : "saved"),
    );
    for (const dependency of dependencies) {
        if (dependency.document == null) continue;
        apps.push(...dependency.document.apps.map((app) => appDraftFromConfig(app, dependency.name, "saved")));
    }

    const convention = primary.config?.multirepo?.branch_convention;
    const branchConvention: BranchConventionDraft =
        convention == null
            ? { type: "none" }
            : convention.type === "regex"
              ? { type: "regex", pattern: convention.pattern, replacement: convention.replacement }
              : { type: convention.type };

    const passthrough: Partial<DocumentPassthrough> = {};
    if (primary.domain != null) passthrough.domain = primary.domain;
    if (primary.registry != null) passthrough.registry = primary.registry;
    if (primary.addons.length > 0) passthrough.addons = primary.addons;

    const hooks: HooksDraft =
        mode === "starter"
            ? { pre_deploy: [], post_deploy: [] }
            : {
                  pre_deploy: primary.hooks.pre_deploy.map(hookDraftFromConfig),
                  post_deploy: primary.hooks.post_deploy.map(hookDraftFromConfig),
              };

    return {
        apps,
        hooks,
        services:
            mode === "starter"
                ? []
                : primary.services.map((service) => {
                      const recipe = toServiceRecipe(service.recipe);
                      const custom = customImageFieldsFromOptions(service.options);
                      return {
                          id: nextDraftId(),
                          recipe,
                          name: service.name,
                          version: service.version ?? "",
                          setupTasks: service.setup_tasks.map(setupTaskDraftFromConfig),
                          env: serviceEnvFromOptions(service.options),
                          image: custom.image,
                          port: custom.port,
                          portName: custom.portName,
                          additionalPorts: custom.additionalPorts,
                          command: custom.command,
                          args: custom.args,
                          readiness: custom.readiness,
                          optionsPassthrough: passthroughOptions(recipe, service.options),
                      };
                  }),
        repos,
        branchConvention,
        passthrough,
    };
}

function appDraftFromConfig(app: PreviewConfig["apps"][number], repoKey: string, origin: AppDraftOrigin): AppDraft {
    const draft = emptyAppDraft(repoKey, origin);
    draft.name = app.name;
    draft.path = app.path;
    draft.buildContext = app.build_context ?? "";
    // A manual-runtime `build` block maps onto the runtime editor. Any other
    // `build` block (a framework preset - node/next/vite/bun - or an explicit
    // dockerfile build block) the three-way selector can't model is preserved
    // verbatim as `buildPassthrough` under "auto", so a save re-emits it instead
    // of silently downgrading it to autodetection.
    if (app.build?.framework === "runtime") {
        draft.buildMode = "runtime";
        draft.runtime = app.build.runtime;
        draft.runtimeVersion = app.build.version ?? "";
        draft.buildScript = app.build.build_script ?? "";
        draft.entrypoint = app.build.entrypoint;
    } else if (app.build != null) {
        draft.buildMode = "auto";
        draft.buildPassthrough = app.build;
    } else if (app.dockerfile != null) {
        draft.buildMode = "dockerfile";
    } else {
        // An app with no build block keeps auto-detection so its existing deploy
        // behavior is preserved; the user can switch it to a method. Fresh starter
        // apps never land here - they carry a seeded runtime build block.
        draft.buildMode = "auto";
    }
    draft.dockerfile = app.dockerfile ?? "";
    draft.port = String(app.port);
    draft.command = app.command ?? "";
    draft.healthCheck = app.health_check ?? "";
    draft.primary = app.primary === true;
    draft.dependsOn = app.depends_on ?? [];
    // Connections become non-sensitive binding rows; build-time secret keys seed
    // sensitive rows (value blank - AWS never returns it), marked build-time. The
    // remaining secrets are merged in from the AWS key list.
    const connectionRows = app.connections.map((connection) =>
        envRow(connection.key, connection.value, false, "config", connection.build_time),
    );
    const buildSecretRows = app.build_secrets.map((key) => envRow(key, "", true, "secret", true));
    draft.env = sortEnvRows([...connectionRows, ...buildSecretRows]);
    return draft;
}

function hookDraftFromConfig(step: PreviewConfig["hooks"]["pre_deploy"][number]): HookDraft {
    return { id: nextDraftId(), app: step.app, command: step.command };
}

function setupTaskDraftFromConfig(task: PreviewConfig["services"][number]["setup_tasks"][number]): SetupTaskDraft {
    const base = emptySetupTaskDraft(task.frequency);
    base.command = task.command;
    if (task.location.type === "in_build") {
        base.locationType = "in_build";
        base.app = task.location.app;
        base.position = task.location.position;
    } else {
        base.locationType = "separate_job";
        base.repo = task.location.repo ?? "";
    }
    return base;
}

// Lenient read-back of a docker-image service's `options.env` (an array of
// {key, value}); tolerant of malformed saved data like the other option reads.
const readServiceEnvSchema = z.array(z.object({ key: z.string(), value: z.string() }));

function serviceEnvFromOptions(options: Record<string, unknown>): ServiceEnvDraft[] {
    const parsed = readServiceEnvSchema.safeParse(options.env);
    if (!parsed.success) return [];
    return parsed.data.map((entry) => serviceEnvRow(entry.key, entry.value));
}

function toServiceRecipe(recipe: string): ServiceRecipe {
    if (
        recipe === "mysql" ||
        recipe === "redis" ||
        recipe === "valkey" ||
        recipe === "temporal" ||
        recipe === "mongodb" ||
        recipe === "upstash" ||
        recipe === "docker-image"
    ) {
        return recipe;
    }
    return "postgres";
}

// Lenient read-back schemas for the untyped `options` bag of a saved service.
// Each top-level field is parsed independently so one malformed entry never
// discards the rest of a partially-authored config.
const readPortDefinitionSchema = z.object({ name: z.string().optional(), port: z.number() });
const readReadinessSchema = z.object({
    http: z.object({ path: z.string(), port_definition: readPortDefinitionSchema }).optional(),
    exec: z.object({ command: z.array(z.string()) }).optional(),
    tcp: z.object({ port_definition: readPortDefinitionSchema }).optional(),
    initial_delay_seconds: z.number().optional(),
    period_seconds: z.number().optional(),
});

interface CustomImageFields {
    image: string;
    port: string;
    portName: string;
    additionalPorts: string;
    command: string;
    args: string;
    readiness: ServiceReadinessDraft;
}

// The `options` keys the custom-image form owns end-to-end. For custom-image
// recipes these are stripped from the passthrough (the form is their source of
// truth, so clearing a field must actually clear it); every other key - and, for
// non-custom-image recipes, every key - is carried through untouched.
const MODELED_SERVICE_OPTION_KEYS = new Set([
    "image",
    "port_definition",
    "additional_ports",
    "command",
    "args",
    "env",
    "readiness",
]);

/**
 * The recipe `options` the form cannot edit, captured so they survive an
 * edit+save. Custom-image recipes drop the keys the form owns; all other recipes
 * (postgres, redis, ...) keep their entire options bag - the form models none of
 * it, so dropping anything would silently reset it to recipe defaults at deploy.
 */
function passthroughOptions(recipe: ServiceRecipe, options: Record<string, unknown>): Record<string, unknown> {
    if (!serviceRecipeUsesCustomImage(recipe)) return { ...options };
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options)) {
        if (!MODELED_SERVICE_OPTION_KEYS.has(key)) rest[key] = value;
    }
    return rest;
}

/**
 * Reads the custom-image draft fields back out of a saved service's `options`
 * bag (only docker-image populates these). Returns empty fields for recipes that
 * have no custom-image options, and tolerates partially-authored configs - this
 * is untyped config data, so each field is probed independently.
 */
function customImageFieldsFromOptions(options: Record<string, unknown>): CustomImageFields {
    const image = typeof options.image === "string" ? options.image : "";
    const primary = readPortDefinitionSchema.safeParse(options.port_definition);
    const additional = z.array(readPortDefinitionSchema).safeParse(options.additional_ports);
    return {
        image,
        port: primary.success ? String(primary.data.port) : "",
        portName: primary.success ? (primary.data.name ?? "") : "",
        additionalPorts: additional.success ? additional.data.map(portDefinitionToLine).join("\n") : "",
        command: readStringArrayLines(options.command),
        args: readStringArrayLines(options.args),
        readiness: readReadinessDraft(options.readiness),
    };
}

/** Renders a recipe port definition back into a `port` / `name:port` editor line. */
function portDefinitionToLine(definition: { name?: string; port: number }): string {
    return definition.name != null && definition.name !== ""
        ? `${definition.name}:${definition.port}`
        : String(definition.port);
}

/** Joins a saved string array into one-token-per-line editor text, or "" when absent/malformed. */
function readStringArrayLines(value: unknown): string {
    const parsed = z.array(z.string()).safeParse(value);
    return parsed.success ? parsed.data.join("\n") : "";
}

/** Maps a saved readiness probe back into its editable draft (none when absent/malformed). */
function readReadinessDraft(value: unknown): ServiceReadinessDraft {
    const parsed = readReadinessSchema.safeParse(value);
    if (!parsed.success) return emptyServiceReadinessDraft();

    const readiness = parsed.data;
    const draft = emptyServiceReadinessDraft();
    draft.initialDelaySeconds = readiness.initial_delay_seconds != null ? String(readiness.initial_delay_seconds) : "";
    draft.periodSeconds = readiness.period_seconds != null ? String(readiness.period_seconds) : "";
    if (readiness.http != null) {
        draft.kind = "http";
        draft.httpPath = readiness.http.path;
        draft.port = String(readiness.http.port_definition.port);
    } else if (readiness.exec != null) {
        draft.kind = "exec";
        draft.execCommand = readiness.exec.command.join("\n");
    } else if (readiness.tcp != null) {
        draft.kind = "tcp";
        draft.port = String(readiness.tcp.port_definition.port);
    }
    return draft;
}

/** Compiles the form draft into the primary document plus one document per dependency repo. */
export function documentsFromDraft(draft: TopologyDraft): CompiledTopology {
    const primaryApps = draft.apps.filter((app) => app.repoKey === PRIMARY_REPO_KEY);
    const primary = compileDocument(primaryApps, draft.services, draft, true);

    const dependencies = draft.repos.map((repo) => {
        const repoApps = draft.apps.filter((app) => app.repoKey === repo.name);
        const compiled = compileDocument(repoApps, [], draft, false);
        return { ...compiled, alias: repo.name, repo: repo.repo };
    });

    return { primary, dependencies };
}

function compileDocument(
    apps: AppDraft[],
    services: ServiceDraft[],
    draft: TopologyDraft,
    isPrimary: boolean,
): CompiledDocument {
    const indexToDraftId = new Map<number, number>();
    const compiledApps = apps.map((app, index) => {
        indexToDraftId.set(index, app.id);
        return compileApp(app);
    });

    const document: Record<string, unknown> = { version: 1 };

    if (isPrimary) {
        if (draft.passthrough.domain != null) document.domain = draft.passthrough.domain;
        if (draft.passthrough.registry != null) document.registry = draft.passthrough.registry;
        const multirepo = compileMultirepo(draft);
        if (multirepo != null) document.config = { multirepo };
    }

    document.apps = compiledApps;
    document.services = services.map((service) => {
        const compiled: Record<string, unknown> = { name: service.name.trim(), recipe: service.recipe };
        if (service.version.trim() !== "") compiled.version = service.version.trim();
        const options = compileServiceOptions(service);
        if (options != null) compiled.options = options;
        const setupTasks = compileSetupTasks(service.setupTasks);
        if (setupTasks.length > 0) compiled.setup_tasks = setupTasks;
        return compiled;
    });

    if (isPrimary && draft.passthrough.addons != null) document.addons = draft.passthrough.addons;
    if (isPrimary) {
        const hooks = compileHooks(draft.hooks);
        if (hooks != null) document.hooks = hooks;
    }

    return { document, indexToDraftId };
}

/**
 * Compiles a service's recipe-specific `options` block. Starts from the
 * passthrough - the options the form cannot edit (postgres user/database/
 * restore_from, ...), preserved verbatim from load so an edit+save never drops
 * them. Custom-image recipes then overlay the form-owned fields (image, primary
 * port and optional name, extra ports, command/args, readiness); blank fields
 * are omitted so a half-authored service stays minimal and clearing a field
 * actually clears it. Returns undefined when there are no options to emit.
 */
function compileServiceOptions(service: ServiceDraft): Record<string, unknown> | undefined {
    const options: Record<string, unknown> = { ...service.optionsPassthrough };

    if (serviceRecipeUsesCustomImage(service.recipe)) {
        if (service.image.trim() !== "") options.image = service.image.trim();

        const portDefinition = compilePort(service.port, service.portName);
        if (portDefinition != null) options.port_definition = portDefinition;

        const additionalPorts = parsePortLines(service.additionalPorts);
        if (additionalPorts.length > 0) options.additional_ports = additionalPorts;

        const command = parseTokenLines(service.command);
        if (command.length > 0) options.command = command;

        const args = parseTokenLines(service.args);
        if (args.length > 0) options.args = args;

        const readiness = compileReadiness(service);
        if (readiness != null) options.readiness = readiness;

        const env = service.env
            .map((row) => ({ key: row.key.trim(), value: row.value }))
            .filter((row) => row.key !== "");
        if (env.length > 0) options.env = env;
    }

    return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Compiles the database setup-task drafts into `setup_tasks` config entries,
 * dropping rows with a blank command. `in_build` tasks carry their app +
 * before/after position; `separate_job` tasks carry an optional repo alias (a
 * blank repo means the primary repo, so it is omitted).
 */
function compileSetupTasks(tasks: SetupTaskDraft[]): Array<Record<string, unknown>> {
    return tasks
        .filter((task) => task.command.trim() !== "")
        .map((task) => {
            const location: Record<string, unknown> =
                task.locationType === "in_build"
                    ? { type: "in_build", app: task.app, position: task.position }
                    : { type: "separate_job" };
            if (task.locationType === "separate_job" && task.repo.trim() !== "") location.repo = task.repo.trim();
            return { command: task.command.trim(), frequency: task.frequency, location };
        });
}

/** Splits a multiline field into trimmed, non-empty lines (one argv token / port per line). */
function parseTokenLines(raw: string): string[] {
    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
}

/** Builds a `{ port, name? }` from a port string and optional name, or undefined when the port is unusable. */
function compilePort(portRaw: string, nameRaw: string): { port: number; name?: string } | undefined {
    const port = Number(portRaw);
    if (portRaw.trim() === "" || !Number.isInteger(port)) return undefined;
    const name = nameRaw.trim();
    if (name === "") return { port };
    return { port, name };
}

/** Parses `port` / `name:port` lines into recipe port definitions, dropping unparseable rows. */
function parsePortLines(raw: string): Array<{ port: number; name?: string }> {
    const ports: Array<{ port: number; name?: string }> = [];
    for (const line of parseTokenLines(raw)) {
        const colon = line.indexOf(":");
        const definition =
            colon === -1 ? compilePort(line, "") : compilePort(line.slice(colon + 1), line.slice(0, colon));
        if (definition != null) ports.push(definition);
    }
    return ports;
}

/**
 * Compiles the readiness draft into the recipe `readiness` shape (exactly one of
 * http/exec/tcp). A blank http/tcp port reuses the service's primary port, since
 * the recipe schema requires a port there. Returns undefined when the probe is
 * disabled or too incomplete to be valid.
 */
function compileReadiness(service: ServiceDraft): Record<string, unknown> | undefined {
    const readiness = service.readiness;
    if (readiness.kind === "none") return undefined;

    const probe = compileReadinessTarget(readiness, service.port);
    if (probe == null) return undefined;

    const initialDelay = Number(readiness.initialDelaySeconds);
    if (readiness.initialDelaySeconds.trim() !== "" && Number.isInteger(initialDelay)) {
        probe.initial_delay_seconds = initialDelay;
    }
    const period = Number(readiness.periodSeconds);
    if (readiness.periodSeconds.trim() !== "" && Number.isInteger(period)) probe.period_seconds = period;
    return probe;
}

/** Builds the http/exec/tcp branch of a readiness probe, or undefined when its required fields are blank. */
function compileReadinessTarget(
    readiness: ServiceReadinessDraft,
    primaryPort: string,
): Record<string, unknown> | undefined {
    if (readiness.kind === "exec") {
        const command = parseTokenLines(readiness.execCommand);
        return command.length > 0 ? { exec: { command } } : undefined;
    }

    const port = compilePort(readiness.port.trim() === "" ? primaryPort : readiness.port, "");
    if (port == null) return undefined;
    if (readiness.kind === "tcp") return { tcp: { port_definition: port } };

    const path = readiness.httpPath.trim();
    return path === "" ? undefined : { http: { path, port_definition: port } };
}

/**
 * Compiles the draft hooks into the document `hooks` block, dropping rows whose
 * `app` and `command` are both blank. Returns undefined when no rows survive, so
 * the document stays minimal (matches the pre-editor passthrough behavior).
 */
function compileHooks(hooks: HooksDraft): Record<string, unknown> | undefined {
    const compileGroup = (steps: HookDraft[]) =>
        steps
            .filter((step) => step.app.trim() !== "" || step.command.trim() !== "")
            .map((step) => ({ app: step.app.trim(), command: step.command.trim() }));
    const preDeploy = compileGroup(hooks.pre_deploy);
    const postDeploy = compileGroup(hooks.post_deploy);
    if (preDeploy.length === 0 && postDeploy.length === 0) return undefined;
    return { pre_deploy: preDeploy, post_deploy: postDeploy };
}

/**
 * Per-row hook validation for the editor, keyed `${hookId}:${field}` (field is
 * `app` or `command`) so the HooksSection can render the message inline on the
 * offending input. Reuses {@link validateHookSteps} - the same rules the API and
 * the worker config validate against - so the UI never green-lights a hook the
 * backend would reject. `appNames` is the set of declared app names a hook may
 * target.
 */
export function hookFieldErrors(hooks: HooksDraft, appNames: string[]): Map<string, string[]> {
    const known = new Set(appNames);
    const result = new Map<string, string[]>();
    const collect = (steps: HookDraft[], group: HookGroupKey) => {
        for (const issue of validateHookSteps(steps, known, group)) {
            const index = issue.path[2];
            const field = issue.path[3];
            if (typeof index !== "number" || typeof field !== "string") continue;
            const step = steps[index];
            if (step == null) continue;
            const key = `${step.id}:${field}`;
            result.set(key, [...(result.get(key) ?? []), issue.message]);
        }
    };
    collect(hooks.pre_deploy, "pre_deploy");
    collect(hooks.post_deploy, "post_deploy");
    return result;
}

function compileApp(app: AppDraft): Record<string, unknown> {
    const compiled: Record<string, unknown> = {
        name: app.name.trim(),
        path: app.path.trim() === "" ? "." : app.path.trim(),
    };
    if (app.buildContext.trim() !== "") compiled.build_context = app.buildContext.trim();
    if (app.buildMode === "runtime") {
        compiled.build = compileRuntimeBuild(app);
    } else if (app.buildMode === "dockerfile" && app.dockerfile.trim() !== "") {
        compiled.dockerfile = app.dockerfile.trim();
    } else if (app.buildMode === "auto" && app.buildPassthrough != null) {
        // A framework preset / dockerfile build block the selector doesn't model,
        // preserved from load - re-emit it verbatim rather than dropping it.
        compiled.build = app.buildPassthrough;
    }

    const port = Number(app.port);
    compiled.port = app.port.trim() !== "" && Number.isFinite(port) ? port : 0;

    // In raw-runtime mode the entrypoint is the start command (baked into the
    // image CMD via `build.entrypoint`), so the legacy `command` override is not
    // emitted from this form.
    if (app.buildMode !== "runtime" && app.command.trim() !== "") compiled.command = app.command.trim();
    if (app.healthCheck.trim() !== "") compiled.health_check = app.healthCheck.trim();
    if (app.primary) compiled.primary = true;
    if (app.dependsOn.length > 0) compiled.depends_on = app.dependsOn;

    // Secrets (sensitive rows) live in AWS; only their build-time subset is named
    // here. Connections (non-sensitive binding rows) are the deploy-time wiring.
    const buildSecrets: string[] = [];
    const connections: Array<Record<string, unknown>> = [];
    for (const row of app.env) {
        const key = row.key.trim();
        if (key === "") continue;
        if (row.sensitive) {
            if (row.buildTime) buildSecrets.push(key);
            continue;
        }
        // A non-sensitive row is a connection: its value is a template (possibly
        // composite, e.g. `mongodb://{{db.host}}:{{db.port}}/x`) resolved at deploy.
        connections.push({ key, value: row.value, build_time: row.buildTime });
    }
    if (buildSecrets.length > 0) compiled.build_secrets = buildSecrets;
    compiled.connections = connections;

    return compiled;
}

/** Compiles a manual-runtime app's fields into a `build: { framework: "runtime", ... }` block. */
function compileRuntimeBuild(app: AppDraft): Record<string, unknown> {
    const build: Record<string, unknown> = {
        framework: "runtime",
        runtime: app.runtime,
        entrypoint: app.entrypoint.trim(),
        // Manual builds always use the repo root as the build context - the whole
        // repo is copied in, nothing hidden. This is deliberate and explicit (no
        // toggle): the schema default is "app", so the override is always emitted.
        build_context: "root",
    };
    if (app.runtimeVersion.trim() !== "") build.version = app.runtimeVersion.trim();
    if (app.buildScript.trim() !== "") build.build_script = app.buildScript.trim();
    return build;
}

/** Sort env rows alphabetically by key; blank-key rows (freshly added) sink to the bottom. */
export function sortEnvRows(rows: EnvRowDraft[]): EnvRowDraft[] {
    return [...rows].sort((a, b) => {
        const aKey = a.key.trim();
        const bKey = b.key.trim();
        if (aKey === "" && bKey === "") return 0;
        if (aKey === "") return 1;
        if (bKey === "") return -1;
        return aKey.localeCompare(bKey, undefined, { sensitivity: "base" });
    });
}

/**
 * Seeds an app's env rows from its existing secret bundle: every secret key
 * becomes a masked, sensitive row (value blank - AWS never returns it). Keys
 * already present as config env rows are skipped (the config env value wins for
 * display; the user can toggle it sensitive).
 */
export function withSecretRows(envRows: EnvRowDraft[], secretKeys: string[]): EnvRowDraft[] {
    const existing = new Set(envRows.map((row) => row.key.trim()));
    // Build-time secrets are already seeded from the document (build_secrets); the
    // rest arrive here from the AWS key list as runtime-only secret rows.
    const secretRows = secretKeys
        .filter((key) => !existing.has(key))
        .map((key) => envRow(key, "", true, "secret", false));
    return sortEnvRows([...envRows, ...secretRows]);
}

/** Key prefixes framework toolchains inline at build time (client bundles). */
const BUILD_TIME_ENV_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "PUBLIC_"];

/** One `KEY=VALUE` line: optional `export`, an env-style key, then the rest of the line. */
const DOTENV_LINE_REGEX = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * Parses pasted `.env` text into key/value pairs so a whole file can be imported
 * at once. Skips blank and `#` comment lines and anything without a valid env key.
 *
 * A value opened with a quote that is not closed on the same line spans following
 * lines until the matching quote - so a multi-line PEM key / cert imports intact
 * instead of being truncated to its first line.
 */
export function parseDotenv(text: string): Array<{ key: string; value: string }> {
    const entries: Array<{ key: string; value: string }> = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        const match = DOTENV_LINE_REGEX.exec(line);
        if (match == null) continue;
        const key = match[1] ?? "";
        const rest = match[2] ?? "";
        const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : undefined;

        if (quote == null) {
            entries.push({ key, value: rest.trim() });
            continue;
        }

        const closeIndex = rest.indexOf(quote, 1);
        if (closeIndex !== -1) {
            entries.push({ key, value: rest.slice(1, closeIndex) });
            continue;
        }

        // Opening quote with no close on this line: consume following lines
        // (PEM keys, certs) up to the matching quote, joining with newlines.
        const parts = [rest.slice(1)];
        while (++i < lines.length) {
            const next = lines[i] ?? "";
            const idx = next.indexOf(quote);
            if (idx !== -1) {
                parts.push(next.slice(0, idx));
                break;
            }
            parts.push(next);
        }
        entries.push({ key, value: parts.join("\n") });
    }
    return entries;
}

/**
 * Merges parsed `.env` entries into an app's variable list. A value with a
 * `{{name.property}}` token becomes a connection; everything else a secret. An
 * existing key is updated in place (keeping its row id and build-time choice); a
 * new key is appended, defaulting build-time on for framework client-bundle vars.
 */
export function envRowsFromDotenv(
    existing: EnvRowDraft[],
    entries: Array<{ key: string; value: string }>,
): EnvRowDraft[] {
    const byKey = new Map(existing.map((row) => [row.key.trim(), row]));
    for (const { key, value } of entries) {
        const trimmedKey = key.trim();
        if (trimmedKey === "") continue;
        const sensitive = !hasConnectionToken(value);
        const current = byKey.get(trimmedKey);
        if (current != null) {
            byKey.set(trimmedKey, { ...current, value, sensitive });
        } else {
            const buildTime = BUILD_TIME_ENV_PREFIXES.some((prefix) => trimmedKey.startsWith(prefix));
            byKey.set(trimmedKey, envRow(trimmedKey, value, sensitive, "new", buildTime));
        }
    }
    return [...byKey.values()];
}

export interface AppSecretsDiff {
    upserts: Array<{ key: string; value: string }>;
    deletes: string[];
}

/**
 * Diffs an app's current env rows against the secret keys it loaded with:
 *   - upserts: sensitive rows with a (re-)entered value.
 *   - deletes: loaded secret keys no longer represented by a sensitive row
 *     (removed, renamed, or toggled back to non-sensitive).
 */
export function diffAppSecrets(envRows: EnvRowDraft[], loadedSecretKeys: string[]): AppSecretsDiff {
    const upserts: Array<{ key: string; value: string }> = [];
    const sensitiveKeys = new Set<string>();
    for (const row of envRows) {
        const key = row.key.trim();
        if (!row.sensitive || key === "") continue;
        sensitiveKeys.add(key);
        if (row.value !== "") upserts.push({ key, value: row.value });
    }
    const deletes = loadedSecretKeys.filter((key) => !sensitiveKeys.has(key));
    return { upserts, deletes };
}

function compileMultirepo(draft: TopologyDraft): Record<string, unknown> | undefined {
    if (draft.repos.length === 0 && draft.branchConvention.type === "none") return undefined;

    const multirepo: Record<string, unknown> = {
        repos: draft.repos.map((repo) => ({
            name: repo.name.trim(),
            repo: repo.repo.trim(),
            fallback_branch: repo.fallbackBranch.trim() === "" ? "main" : repo.fallbackBranch.trim(),
        })),
    };

    if (draft.branchConvention.type === "regex") {
        multirepo.branch_convention = {
            type: "regex",
            pattern: draft.branchConvention.pattern,
            replacement: draft.branchConvention.replacement,
        };
    } else if (draft.branchConvention.type !== "none") {
        multirepo.branch_convention = { type: draft.branchConvention.type };
    }

    return multirepo;
}

/** Field keys the app card understands; everything else lands in `documentErrors`. */
export type AppDraftField =
    | "name"
    | "path"
    | "buildContext"
    | "dockerfile"
    | "runtime"
    | "runtimeVersion"
    | "buildScript"
    | "entrypoint"
    | "port"
    | "command"
    | "healthCheck"
    | "primary"
    | "dependsOn"
    | "env"
    | "connections"
    | "buildSecrets";

export interface DraftIssues {
    /** Keyed `${draftId}:${field}`. */
    fieldErrors: Map<string, string[]>;
    fieldWarnings: Map<string, string[]>;
    documentErrors: string[];
    documentWarnings: string[];
}

export function emptyDraftIssues(): DraftIssues {
    return { fieldErrors: new Map(), fieldWarnings: new Map(), documentErrors: [], documentWarnings: [] };
}

export function fieldIssueKey(draftId: number, field: AppDraftField): string {
    return `${draftId}:${field}`;
}

/**
 * Maps ConfigIssues (Zod-style paths into a compiled document) onto draft field
 * keys via the compile-time index map. Issues that don't point inside `apps`
 * become document-level messages.
 */
export function mapIssuesToDraft(
    issues: ConfigIssue[],
    indexToDraftId: Map<number, number>,
    into?: DraftIssues,
): DraftIssues {
    const result = into ?? emptyDraftIssues();

    for (const issue of issues) {
        const message = issue.message;
        const isWarning = issue.severity === "warning";
        const field = resolveAppField(issue.path);
        const appIndex = issue.path[0] === "apps" && typeof issue.path[1] === "number" ? issue.path[1] : undefined;
        const draftId = appIndex != null ? indexToDraftId.get(appIndex) : undefined;

        if (field != null && draftId != null) {
            const key = fieldIssueKey(draftId, field);
            const bucket = isWarning ? result.fieldWarnings : result.fieldErrors;
            bucket.set(key, [...(bucket.get(key) ?? []), message]);
            continue;
        }

        const pathLabel = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        const target = isWarning ? result.documentWarnings : result.documentErrors;
        target.push(`${pathLabel}${message}`);
    }

    return result;
}

const APP_FIELD_BY_DOCUMENT_KEY: Record<string, AppDraftField> = {
    name: "name",
    path: "path",
    build_context: "buildContext",
    dockerfile: "dockerfile",
    port: "port",
    command: "command",
    health_check: "healthCheck",
    primary: "primary",
    depends_on: "dependsOn",
    connections: "connections",
    build_secrets: "buildSecrets",
};

// Raw-runtime schema errors carry a `build` path (`apps.i.build.entrypoint`);
// map the build sub-key to its draft field so they surface inline on the editor.
const RUNTIME_BUILD_FIELD_BY_KEY: Record<string, AppDraftField> = {
    runtime: "runtime",
    version: "runtimeVersion",
    build_script: "buildScript",
    entrypoint: "entrypoint",
};

function resolveAppField(path: Array<string | number>): AppDraftField | undefined {
    if (path[0] !== "apps" || typeof path[1] !== "number") return undefined;
    const key = path[2];
    if (typeof key !== "string") return undefined;
    if (key === "build") {
        const subKey = path[3];
        return typeof subKey === "string" ? RUNTIME_BUILD_FIELD_BY_KEY[subKey] : undefined;
    }
    return APP_FIELD_BY_DOCUMENT_KEY[key];
}

/** Maps a document field key (`health_check`) to its draft field (`healthCheck`), for focus deep-links. */
export function appFieldFromDocumentKey(key: string): AppDraftField | undefined {
    return APP_FIELD_BY_DOCUMENT_KEY[key];
}

/** Stable serialization of a compiled topology, for per-repo saved/unsaved tracking. */
export function snapshotDocument(document: Record<string, unknown>): string {
    return JSON.stringify(document);
}

/**
 * Drops `depends_on` entries that no longer reference an existing app or service.
 * Called after a deletion (an app removed, or a dependency repo's apps dropped) so
 * a stale reference doesn't linger as a badge the dropdown can no longer deselect.
 * Not called on rename - names stay valid there.
 */
export function pruneDanglingDependsOn(draft: TopologyDraft): TopologyDraft {
    const validNames = new Set([
        ...draft.apps.map((app) => app.name),
        ...draft.services.map((service) => service.name),
    ]);
    return {
        ...draft,
        apps: draft.apps.map((app) => {
            const filtered = app.dependsOn.filter((name) => validNames.has(name));
            return filtered.length === app.dependsOn.length ? app : { ...app, dependsOn: filtered };
        }),
    };
}
