import {
    validateHookSteps,
    type ConfigIssue,
    type HookGroupKey,
    type PreviewConfig,
    type SuggestedApp,
} from "@autonoma/types";
import { z } from "zod";

export const PRIMARY_REPO_KEY = "primary";

export type ServiceRecipe = "postgres" | "redis" | "valkey" | "temporal" | "mongodb" | "upstash" | "docker-image";

export const SERVICE_OPTIONS: Array<{
    recipe: ServiceRecipe;
    label: string;
    defaultName: string;
    version?: string;
    meta: string;
}> = [
    { recipe: "postgres", label: "Postgres", defaultName: "db", version: "16", meta: "16 · 5432" },
    { recipe: "redis", label: "Redis", defaultName: "cache", version: "7", meta: "7 · 6379" },
    { recipe: "valkey", label: "Valkey", defaultName: "valkey", version: "7", meta: "7 · 6379" },
    { recipe: "mongodb", label: "MongoDB", defaultName: "mongo", version: "7", meta: "7 · 27017" },
    { recipe: "upstash", label: "Upstash", defaultName: "upstash", meta: "· 8000" },
    { recipe: "temporal", label: "Temporal", defaultName: "temporal", meta: "· 7233" },
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
 * Whether a service recipe resolves `{{<name>.url}}` to an in-cluster
 * connection string at deploy time (postgres -> `postgresql://…`,
 * redis/valkey -> `redis://…`, mongodb -> `mongodb://…?directConnection=true`).
 * Temporal speaks gRPC with no single-scheme URL, and Upstash exposes both a
 * REST and a RESP endpoint with no single canonical URL, so only
 * `{{<name>.host}}`/`{{<name>.port}}` are offered for those. Mirrors the recipe
 * `connectionInfo.url` support in apps/previewkit.
 */
export function serviceRecipeSupportsUrlToken(recipe: ServiceRecipe): boolean {
    return recipe === "postgres" || recipe === "redis" || recipe === "valkey" || recipe === "mongodb";
}

/** Where an env/secret row came from on load, so a save can diff secret changes. */
export type EnvRowOrigin = "config" | "secret" | "new";

export interface EnvRowDraft {
    id: number;
    key: string;
    value: string;
    /** When true the row is stored as a secret (AWS), not plaintext config `env`. */
    sensitive: boolean;
    origin: EnvRowOrigin;
}

export function envRow(key: string, value: string, sensitive = false, origin: EnvRowOrigin = "new"): EnvRowDraft {
    return { id: nextDraftId(), key, value, sensitive, origin };
}

export type AppDraftOrigin = "saved" | "manual" | "suggestion" | "starter";

export interface AppDraft {
    id: number;
    /** `PRIMARY_REPO_KEY` or a dependency repo alias (`RepoDraft.name`). */
    repoKey: string;
    name: string;
    path: string;
    buildContext: string;
    autodetectDockerfile: boolean;
    dockerfile: string;
    port: string;
    command: string;
    healthCheck: string;
    primary: boolean;
    dependsOn: string[];
    env: EnvRowDraft[];
    buildArgs: EnvRowDraft[];
    buildSecrets: string[];
    replicas: string;
    /** Preserved but not editable in the form (set by suggestions / saved configs). */
    monorepo?: "turbo";
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

export interface ServiceDraft {
    id: number;
    recipe: ServiceRecipe;
    name: string;
    version: string;
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
    env: EnvRowDraft[];
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

export function emptyAppDraft(repoKey: string, origin: AppDraftOrigin = "manual"): AppDraft {
    return {
        id: nextDraftId(),
        repoKey,
        name: "",
        path: ".",
        buildContext: "",
        autodetectDockerfile: true,
        dockerfile: "",
        port: "",
        command: "",
        healthCheck: "/",
        primary: false,
        dependsOn: [],
        env: [],
        buildArgs: [],
        buildSecrets: [],
        replicas: "1",
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
        image: "",
        port: "",
        portName: "",
        additionalPorts: "",
        command: "",
        args: "",
        readiness: emptyServiceReadinessDraft(),
        env: [],
    };
}

export function appDraftFromSuggestion(suggestion: SuggestedApp, repoKey: string): AppDraft {
    const draft = emptyAppDraft(repoKey, "suggestion");
    draft.name = suggestion.name;
    draft.path = suggestion.path;
    if (suggestion.dockerfile != null) {
        draft.autodetectDockerfile = false;
        draft.dockerfile = suggestion.dockerfile;
    }
    if (suggestion.port != null) draft.port = String(suggestion.port);
    if (suggestion.command != null) draft.command = suggestion.command;
    if (suggestion.monorepo != null) draft.monorepo = suggestion.monorepo;
    return draft;
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

    const apps = primary.apps.map((app) =>
        appDraftFromConfig(app, PRIMARY_REPO_KEY, mode === "starter" ? "starter" : "saved"),
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
                      const custom = customImageFieldsFromOptions(service.options);
                      return {
                          id: nextDraftId(),
                          recipe: toServiceRecipe(service.recipe),
                          name: service.name,
                          version: service.version ?? "",
                          image: custom.image,
                          port: custom.port,
                          portName: custom.portName,
                          additionalPorts: custom.additionalPorts,
                          command: custom.command,
                          args: custom.args,
                          readiness: custom.readiness,
                          env: Object.entries(service.env).map(([key, value]) => envRow(key, value, false, "config")),
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
    draft.autodetectDockerfile = app.dockerfile == null;
    draft.dockerfile = app.dockerfile ?? "";
    draft.port = String(app.port);
    draft.command = app.command ?? "";
    draft.healthCheck = app.health_check ?? "";
    draft.primary = app.primary === true;
    draft.dependsOn = app.depends_on ?? [];
    draft.env = sortEnvRows(Object.entries(app.env).map(([key, value]) => envRow(key, value, false, "config")));
    draft.buildArgs = Object.entries(app.build_args).map(([key, value]) => envRow(key, value, false, "config"));
    draft.buildSecrets = app.build_secrets;
    draft.replicas = String(app.replicas);
    if (app.monorepo != null) draft.monorepo = app.monorepo;
    return draft;
}

function hookDraftFromConfig(step: PreviewConfig["hooks"]["pre_deploy"][number]): HookDraft {
    return { id: nextDraftId(), app: step.app, command: step.command };
}

export function isUntouchedStarterApp(app: AppDraft): boolean {
    return app.origin === "starter";
}

function toServiceRecipe(recipe: string): ServiceRecipe {
    if (
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
        const env: Record<string, string> = {};
        for (const row of service.env) {
            if (row.key.trim() !== "") env[row.key.trim()] = row.value;
        }
        if (Object.keys(env).length > 0) compiled.env = env;
        const options = compileServiceOptions(service);
        if (options != null) compiled.options = options;
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
 * Compiles a service's recipe-specific `options` block. Only custom-image
 * recipes (docker-image) have one today: the form's image, primary port (and
 * optional port name), extra ports, command/args, and readiness probe map onto
 * the recipe `options` shape. Blank fields are omitted so a half-authored
 * service stays minimal; the previewkit recipe schema enforces the required ones
 * at deploy time. Returns undefined when there are no options to emit.
 */
function compileServiceOptions(service: ServiceDraft): Record<string, unknown> | undefined {
    if (!serviceRecipeUsesCustomImage(service.recipe)) return undefined;

    const options: Record<string, unknown> = {};
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

    return Object.keys(options).length > 0 ? options : undefined;
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
    if (!app.autodetectDockerfile && app.dockerfile.trim() !== "") compiled.dockerfile = app.dockerfile.trim();
    if (app.monorepo != null) compiled.monorepo = app.monorepo;

    const port = Number(app.port);
    compiled.port = app.port.trim() !== "" && Number.isFinite(port) ? port : 0;

    if (app.command.trim() !== "") compiled.command = app.command.trim();
    if (app.healthCheck.trim() !== "") compiled.health_check = app.healthCheck.trim();
    if (app.primary) compiled.primary = true;
    if (app.dependsOn.length > 0) compiled.depends_on = app.dependsOn;

    const replicas = Number(app.replicas);
    if (app.replicas.trim() !== "" && Number.isFinite(replicas)) compiled.replicas = replicas;
    const buildArgs: Record<string, string> = {};
    for (const row of app.buildArgs) {
        if (row.key.trim() !== "") buildArgs[row.key.trim()] = row.value;
    }
    if (Object.keys(buildArgs).length > 0) compiled.build_args = buildArgs;
    const buildSecrets = app.buildSecrets.map((secret) => secret.trim()).filter((secret) => secret !== "");
    if (buildSecrets.length > 0) compiled.build_secrets = buildSecrets;

    const env: Record<string, string> = {};
    for (const row of app.env) {
        // Sensitive rows are persisted as secrets (AWS), never as plaintext config env.
        if (row.sensitive) continue;
        if (row.key.trim() !== "") env[row.key.trim()] = row.value;
    }
    compiled.env = env;

    return compiled;
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
    const secretRows = secretKeys.filter((key) => !existing.has(key)).map((key) => envRow(key, "", true, "secret"));
    return sortEnvRows([...envRows, ...secretRows]);
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
    | "port"
    | "command"
    | "healthCheck"
    | "primary"
    | "dependsOn"
    | "env"
    | "buildArgs"
    | "buildSecrets"
    | "replicas";

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
    env: "env",
    build_args: "buildArgs",
    build_secrets: "buildSecrets",
    replicas: "replicas",
};

function resolveAppField(path: Array<string | number>): AppDraftField | undefined {
    if (path[0] !== "apps" || typeof path[1] !== "number") return undefined;
    const key = path[2];
    if (typeof key !== "string") return undefined;
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
