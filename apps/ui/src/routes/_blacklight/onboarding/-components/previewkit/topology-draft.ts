import type { ConfigIssue, PreviewConfig, SuggestedApp } from "@autonoma/types";

export const PRIMARY_REPO_KEY = "primary";

export type ServiceRecipe = "postgres" | "redis" | "valkey" | "temporal";

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
    { recipe: "temporal", label: "Temporal", defaultName: "temporal", meta: "· 7233" },
];

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

export interface ServiceDraft {
    id: number;
    recipe: ServiceRecipe;
    name: string;
    version: string;
    env: EnvRowDraft[];
    s3: boolean;
    sqs: boolean;
    sns: boolean;
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

/** Document-level fields the form doesn't expose but must survive a round-trip. */
export type DocumentPassthrough = Pick<PreviewConfig, "domain" | "registry" | "hooks" | "addons">;

export interface TopologyDraft {
    apps: AppDraft[];
    services: ServiceDraft[];
    repos: RepoDraft[];
    branchConvention: BranchConventionDraft;
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
    if (primary.hooks.pre_deploy.length > 0 || primary.hooks.post_deploy.length > 0) passthrough.hooks = primary.hooks;

    return {
        apps,
        services:
            mode === "starter"
                ? []
                : primary.services.map((service) => ({
                      id: nextDraftId(),
                      recipe: toServiceRecipe(service.recipe),
                      name: service.name,
                      version: service.version ?? "",
                      env: Object.entries(service.env).map(([key, value]) => envRow(key, value, false, "config")),
                      s3: service.s3 === true,
                      sqs: service.sqs === true,
                      sns: service.sns === true,
                  })),
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

export function isUntouchedStarterApp(app: AppDraft): boolean {
    return app.origin === "starter";
}

function toServiceRecipe(recipe: string): ServiceRecipe {
    if (recipe === "redis" || recipe === "valkey" || recipe === "temporal") return recipe;
    return "postgres";
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
        if (service.s3) compiled.s3 = true;
        if (service.sqs) compiled.sqs = true;
        if (service.sns) compiled.sns = true;
        return compiled;
    });

    if (isPrimary && draft.passthrough.addons != null) document.addons = draft.passthrough.addons;
    if (isPrimary && draft.passthrough.hooks != null) document.hooks = draft.passthrough.hooks;

    return { document, indexToDraftId };
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
