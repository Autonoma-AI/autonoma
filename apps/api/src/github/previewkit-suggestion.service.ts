import type { LanguageModel } from "@autonoma/ai";
import {
    type SuggestEnvVarsInput,
    type SuggestEnvVarsResult,
    type SuggestServicesInput,
    type SuggestServicesResult,
    type SuggestableServiceRecipe,
    type SuggestedEnvGroup,
    SuggestedEnvGroupSchema,
    type SuggestedEnvVar,
    type SuggestedService,
    SuggestedServiceSchema,
    type SuggestionServiceRef,
} from "@autonoma/types";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";
import { Service } from "../routes/service";
import type { RepoContext, RepoReader } from "./repo-reader";

/** Filenames scanned for a repo's example environment file, in priority order. */
const DOTENV_FILENAMES = [".env.example", ".env.sample", ".env.template"];
/** Docker Compose filenames scanned at the repo root. */
const COMPOSE_FILENAMES = ["docker-compose.yaml", "docker-compose.yml", "compose.yaml", "compose.yml"];
/** Bound on how many dependencies / env keys we feed the model, to keep prompts small. */
const MAX_SIGNAL_ENTRIES = 120;
/**
 * Env-key prefixes whose values a framework inlines into the client bundle at
 * BUILD time (so they must be present during the image build, not just at
 * runtime). Used by the offline heuristic to flag `build_time`.
 */
const BUILD_TIME_KEY_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "PUBLIC_"];

// Default name and pre-filled version per recipe. We only suggest a version for services whose
// image tag maps cleanly to a well-known release (postgres 16, redis/valkey/mongo 7). Recipes are
// omitted where a single generic tag would be misleading: temporal's tag namespace is the CLI
// version (1.7.x), not the server version; upstash has separate proxy and backing-redis tags; and
// docker-image tags are app-specific. Omitting `version` here does not mean "latest" - the recipe
// applies its own vetted default (see apps/previewkit/src/recipes/*), so the user can leave it blank.
const RECIPE_DEFAULTS: Record<SuggestableServiceRecipe, { name: string; version?: string }> = {
    postgres: { name: "db", version: "16" },
    redis: { name: "cache", version: "7" },
    valkey: { name: "valkey", version: "7" },
    mongodb: { name: "mongo", version: "7" },
    upstash: { name: "upstash" },
    temporal: { name: "temporal" },
    "docker-image": { name: "container" },
};

// Order matters: the most specific dependency wins (e.g. `@upstash/redis` before `redis`).
const DEPENDENCY_RECIPES: Array<{ recipe: SuggestableServiceRecipe; deps: string[] }> = [
    { recipe: "postgres", deps: ["pg", "postgres", "postgresql"] },
    { recipe: "mongodb", deps: ["mongodb", "mongoose"] },
    { recipe: "upstash", deps: ["@upstash/redis"] },
    { recipe: "temporal", deps: ["@temporalio/client", "@temporalio/worker", "temporalio"] },
    { recipe: "redis", deps: ["redis", "ioredis"] },
];

export interface DotenvEntry {
    key: string;
    value: string;
    comment?: string;
}

export interface ServiceSignals {
    dependencies: string[];
    composeImages: string[];
    envKeys: string[];
}

export interface AppEnvSignal {
    name: string;
    entries: DotenvEntry[];
    dependencies: string[];
    /** The primary app receives proactively-suggested service-connection vars. */
    primary?: boolean;
}

const aiServiceResultSchema = z.object({ services: z.array(SuggestedServiceSchema) });
const aiEnvResultSchema = z.object({
    apps: z.array(SuggestedEnvGroupSchema),
    services: z.array(SuggestedEnvGroupSchema),
});

const composeDocSchema = z.object({ services: z.record(z.string(), z.unknown()).optional() });
const composeServiceSchema = z.object({ image: z.string() });

const SERVICE_SYSTEM_PROMPT = `You are a preview-infrastructure assistant for PreviewKit. Given signals collected from a customer's repository (package.json dependencies, docker-compose service images, and .env.example keys), propose the managed backing services their apps need for a preview environment.

Rules:
- Only suggest a service when the signals clearly support it. Never invent services.
- Map to these recipes only: postgres, redis, valkey, mongodb, upstash, temporal, docker-image.
- Prefer one instance per distinct backing store.
- Give each suggestion a short kubernetes-safe name (lowercase letters, digits, hyphens), a sensible version when applicable, a confidence, and cite the concrete evidence you used.
- Return an empty list when nothing is clearly needed.`;

const ENV_SYSTEM_PROMPT = `You are a preview-infrastructure assistant for PreviewKit. For each app, given its .env.example entries (key, example value, optional comment) and dependencies, propose the environment variables it needs in a preview environment. Each app carries a "primary" flag - the primary app's URL becomes the preview URL.

Every variable is exactly ONE of two kinds. Classify each carefully:

1. CONNECTION (sensitive=false): its value WIRES to a managed service or another app, so it must contain at least one \`{{name.property}}\` token. Put the full templated string in "reference" (NOT "value"). This is the ONLY case where sensitive=false.
2. SECRET (sensitive=true): everything else the user supplies a value for - API keys, tokens, passwords, AND plain configuration like flags, ports, hostnames, environment names, feature toggles. On this platform every non-connection value is stored as a write-only secret. Do NOT emit a value/reference for a secret; leave "value" empty (the user fills it in). NEVER mark a plain literal (a flag, a URL you cannot template, an env name) as sensitive=false - if it has no \`{{...}}\` token it is a SECRET.

Most variables are SECRETS. Only service/app wiring is a connection.

Building a connection "reference":
- You are given the exact reference tokens available. Services expose \`{{name.host}}\` and \`{{name.port}}\`; postgres/redis/valkey/mongodb also expose \`{{name.url}}\`. Apps expose \`{{name.url}}\`.
- Use a single \`{{name.url}}\` when the standard connection URL is enough: e.g. DATABASE_URL = {{db.url}}, REDIS_URL = {{cache.url}}, an app-to-app URL API_URL = {{web.url}}.
- Build a COMPOSITE template (literal text + tokens) when the client needs a specific connection string, or the service has no \`.url\` token:
  - MongoDB with options: MONGO_URI = mongodb://{{db.host}}:{{db.port}}/preview?replicaSet=rs0&directConnection=true
  - Temporal (no url token): TEMPORAL_ADDRESS = {{temporal.host}}:{{temporal.port}}
  - Upstash (no url token): compose the endpoint the client SDK expects from {{name.host}}/{{name.port}}.
- For EVERY managed service in the input, proactively propose the connection variable an app needs to reach it - even when no .env.example lists it - using the key idiomatic to the app's framework. Attach it to the app whose dependencies use that service; if unclear, the primary app. Skip a service an app already references.

build_time:
- Set build_time=true when the value must exist during the image BUILD, not only at runtime. Clearest cases: framework variables inlined into the client bundle at build (Next.js \`NEXT_PUBLIC_*\`, Vite \`VITE_*\`, \`PUBLIC_*\`), and any value read by the build or install command.
- Otherwise set build_time=false (or omit). Connections are resolved at deploy and injected at runtime by default; only set build_time=true on a connection when the build itself consumes the resolved value.

Also:
- Give each variable a short description.
- Only include a "services" group when a managed service genuinely needs configuration.
- Do not invent variables with no basis in the signals unless they are standard and clearly required by a detected framework or a provided managed service.`;

export class PreviewkitSuggestionService extends Service {
    private modelPromise?: Promise<LanguageModel | undefined>;

    constructor(
        private readonly repoReader: RepoReader,
        /** Attempt the Gemini enrichment pass. Disabled in tests to keep them deterministic and offline. */
        private readonly attemptAi = true,
    ) {
        super();
    }

    async suggestServices(organizationId: string, input: SuggestServicesInput): Promise<SuggestServicesResult> {
        this.logger.info("Suggesting services", {
            organizationId,
            applicationId: input.applicationId,
            appCount: input.apps.length,
        });

        let context: RepoContext;
        try {
            context = await this.repoReader.resolveRepoContext(
                organizationId,
                input.applicationId,
                input.githubRepositoryId,
            );
        } catch (err) {
            this.logger.warn("Service suggestion unavailable", {
                organizationId,
                applicationId: input.applicationId,
                err,
            });
            return { status: "unavailable", reason: describeError(err), services: [] };
        }

        const signals = await this.collectServiceSignals(context, input);
        const heuristic = heuristicServices(signals);
        const services = await this.enrichServices(signals, heuristic);
        this.logger.info("Service suggestions ready", { applicationId: input.applicationId, count: services.length });
        return { status: "ok", services };
    }

    async suggestEnvVars(organizationId: string, input: SuggestEnvVarsInput): Promise<SuggestEnvVarsResult> {
        this.logger.info("Suggesting env vars", {
            organizationId,
            applicationId: input.applicationId,
            appCount: input.apps.length,
            serviceCount: input.services.length,
        });

        let context: RepoContext;
        try {
            context = await this.repoReader.resolveRepoContext(
                organizationId,
                input.applicationId,
                input.githubRepositoryId,
            );
        } catch (err) {
            this.logger.warn("Env var suggestion unavailable", {
                organizationId,
                applicationId: input.applicationId,
                err,
            });
            return { status: "unavailable", reason: describeError(err), apps: [], services: [] };
        }

        const appSignals: AppEnvSignal[] = [];
        for (const app of input.apps) {
            const pkg = await this.repoReader.readPackageJson(context, joinRepoPath(app.path, "package.json"));
            const dependencies = pkg == null ? [] : Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
            appSignals.push({
                name: app.name,
                entries: await this.readAppDotenv(context, app.path),
                dependencies,
                primary: app.primary === true,
            });
        }

        const heuristic = heuristicEnvVars(appSignals, input.services);
        const enriched = await this.enrichEnvVars(appSignals, input.services, heuristic);
        const withConnections = ensureServiceConnectionVars(enriched, appSignals, input.services);
        this.logger.info("Env var suggestions ready", {
            applicationId: input.applicationId,
            appGroups: withConnections.apps.length,
            serviceGroups: withConnections.services.length,
        });
        return { status: "ok", apps: withConnections.apps, services: withConnections.services };
    }

    private async collectServiceSignals(context: RepoContext, input: SuggestServicesInput): Promise<ServiceSignals> {
        const dependencies = new Set<string>();
        const envKeys = new Set<string>();
        for (const app of input.apps) {
            const pkg = await this.repoReader.readPackageJson(context, joinRepoPath(app.path, "package.json"));
            if (pkg != null) {
                for (const dep of Object.keys(pkg.dependencies)) dependencies.add(dep);
                for (const dep of Object.keys(pkg.devDependencies)) dependencies.add(dep);
            }
            for (const entry of await this.readAppDotenv(context, app.path)) envKeys.add(entry.key);
        }
        return {
            dependencies: [...dependencies].slice(0, MAX_SIGNAL_ENTRIES),
            composeImages: await this.readComposeImages(context),
            envKeys: [...envKeys].slice(0, MAX_SIGNAL_ENTRIES),
        };
    }

    /** Parsed entries from the first example env file found in the app dir, falling back to the repo root. */
    private async readAppDotenv(context: RepoContext, dir: string): Promise<DotenvEntry[]> {
        const inDir = await this.firstDotenv(context, dir);
        if (inDir.length > 0) return inDir;
        if (joinRepoPath(dir, "") === "") return [];
        return await this.firstDotenv(context, ".");
    }

    private async firstDotenv(context: RepoContext, dir: string): Promise<DotenvEntry[]> {
        for (const filename of DOTENV_FILENAMES) {
            const raw = await this.repoReader.getFileContent(context, joinRepoPath(dir, filename));
            if (raw != null) return parseDotenv(raw);
        }
        return [];
    }

    private async readComposeImages(context: RepoContext): Promise<string[]> {
        for (const filename of COMPOSE_FILENAMES) {
            const raw = await this.repoReader.getFileContent(context, filename);
            if (raw == null) continue;
            try {
                return parseComposeImages(parseYaml(raw));
            } catch (err) {
                this.logger.debug("Failed to parse docker-compose during suggestion", {
                    fullName: context.repo.fullName,
                    filename,
                    err,
                });
            }
        }
        return [];
    }

    private async enrichServices(signals: ServiceSignals, heuristic: SuggestedService[]): Promise<SuggestedService[]> {
        const model = await this.getModel();
        if (model == null) return heuristic;
        try {
            const { ObjectGenerator } = await import("@autonoma/ai");
            const generator = new ObjectGenerator({
                model,
                systemPrompt: SERVICE_SYSTEM_PROMPT,
                schema: aiServiceResultSchema,
            });
            const result = await generator.generate({
                userPrompt: JSON.stringify({ signals, heuristicSuggestions: heuristic }),
            });
            return result.services.length > 0 ? result.services : heuristic;
        } catch (err) {
            this.logger.warn("AI service enrichment failed, using heuristics", { err });
            return heuristic;
        }
    }

    private async enrichEnvVars(
        appSignals: AppEnvSignal[],
        services: SuggestionServiceRef[],
        heuristic: { apps: SuggestedEnvGroup[]; services: SuggestedEnvGroup[] },
    ): Promise<{ apps: SuggestedEnvGroup[]; services: SuggestedEnvGroup[] }> {
        const model = await this.getModel();
        if (model == null) return heuristic;
        try {
            const { ObjectGenerator } = await import("@autonoma/ai");
            const generator = new ObjectGenerator({
                model,
                systemPrompt: ENV_SYSTEM_PROMPT,
                schema: aiEnvResultSchema,
            });
            const result = await generator.generate({
                userPrompt: JSON.stringify({
                    apps: appSignals,
                    services,
                    // Services expose host/port (+ url for postgres/redis/valkey/mongodb);
                    // apps expose their public url. Both are valid connection tokens.
                    referenceTokens: [
                        ...services.flatMap(referenceTokensForService),
                        ...appSignals.map((app) => `{{${app.name}.url}}`),
                    ],
                }),
            });
            const appNames = new Set(appSignals.map((app) => app.name));
            const serviceNames = new Set(services.map((service) => service.name));
            const apps = result.apps.filter((group) => appNames.has(group.name) && group.vars.length > 0);
            const enrichedServices = result.services.filter(
                (group) => serviceNames.has(group.name) && group.vars.length > 0,
            );
            return apps.length > 0 || enrichedServices.length > 0 ? { apps, services: enrichedServices } : heuristic;
        } catch (err) {
            this.logger.warn("AI env var enrichment failed, using heuristics", { err });
            return heuristic;
        }
    }

    private getModel(): Promise<LanguageModel | undefined> {
        if (!this.attemptAi) return Promise.resolve(undefined);
        if (this.modelPromise == null) {
            this.modelPromise = import("@autonoma/ai")
                .then((ai) => {
                    const registry = new ai.ModelRegistry({ models: ai.MODEL_ENTRIES });
                    return registry.getModel({
                        model: "GEMINI_3_FLASH_PREVIEW",
                        tag: "previewkit-suggestions",
                        reasoning: "low",
                    });
                })
                .catch((err) => {
                    this.logger.warn("AI unavailable for PreviewKit suggestions, using heuristics", { err });
                    return undefined;
                });
        }
        return this.modelPromise;
    }
}

/** Parses `KEY=VALUE` lines from a dotenv file, attaching any immediately-preceding `#` comment lines. */
export function parseDotenv(raw: string): DotenvEntry[] {
    const entries: DotenvEntry[] = [];
    let pendingComment = "";
    for (const rawLine of raw.split("\n")) {
        const line = rawLine.trim();
        if (line === "") {
            pendingComment = "";
            continue;
        }
        if (line.startsWith("#")) {
            const text = line.replace(/^#+\s*/, "").trim();
            pendingComment = pendingComment === "" ? text : `${pendingComment} ${text}`;
            continue;
        }
        const eq = line.indexOf("=");
        const key =
            eq > 0
                ? line
                      .slice(0, eq)
                      .replace(/^export\s+/, "")
                      .trim()
                : "";
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            pendingComment = "";
            continue;
        }
        const entry: DotenvEntry = { key, value: stripQuotes(line.slice(eq + 1).trim()) };
        if (pendingComment !== "") entry.comment = pendingComment;
        entries.push(entry);
        pendingComment = "";
    }
    return entries;
}

/** Extracts service image strings from a parsed docker-compose document. */
export function parseComposeImages(doc: unknown): string[] {
    const parsed = composeDocSchema.safeParse(doc);
    if (!parsed.success || parsed.data.services == null) return [];
    const images: string[] = [];
    for (const value of Object.values(parsed.data.services)) {
        const service = composeServiceSchema.safeParse(value);
        if (service.success) images.push(service.data.image);
    }
    return images;
}

/** Deterministic service suggestions from collected signals; one suggestion per distinct recipe. */
export function heuristicServices(signals: ServiceSignals): SuggestedService[] {
    const hits = new Map<SuggestableServiceRecipe, { evidence: string[]; strong: boolean }>();
    const add = (recipe: SuggestableServiceRecipe, evidence: string, strong: boolean) => {
        const existing = hits.get(recipe);
        if (existing == null) {
            hits.set(recipe, { evidence: [evidence], strong });
            return;
        }
        if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
        existing.strong = existing.strong || strong;
    };

    for (const dep of signals.dependencies) {
        const recipe = mapDependencyToRecipe(dep);
        if (recipe != null) add(recipe, `dependency: ${dep}`, true);
    }
    for (const image of signals.composeImages) {
        const recipe = mapImageToRecipe(image);
        if (recipe != null) add(recipe, `docker-compose image: ${image}`, true);
    }
    for (const key of signals.envKeys) {
        const recipe = mapEnvKeyToRecipe(key);
        if (recipe != null) add(recipe, `env var: ${key}`, false);
    }

    return [...hits].map(([recipe, hit]) => {
        const defaults = RECIPE_DEFAULTS[recipe];
        const suggestion: SuggestedService = {
            recipe,
            name: defaults.name,
            confidence: hit.strong ? "high" : "medium",
            evidence: hit.evidence.slice(0, 4),
        };
        if (defaults.version != null) suggestion.version = defaults.version;
        return suggestion;
    });
}

/** Deterministic env-var suggestions parsed from each app's `.env.example`, mapped to service tokens where possible. */
export function heuristicEnvVars(
    apps: AppEnvSignal[],
    services: SuggestionServiceRef[],
): { apps: SuggestedEnvGroup[]; services: SuggestedEnvGroup[] } {
    const appGroups = apps
        .map((app) => ({ name: app.name, vars: app.entries.map((entry) => heuristicEnvVar(entry, services)) }))
        .filter((group) => group.vars.length > 0);
    return { apps: appGroups, services: [] };
}

export function ensureServiceConnectionVars(
    groups: { apps: SuggestedEnvGroup[]; services: SuggestedEnvGroup[] },
    apps: AppEnvSignal[],
    services: SuggestionServiceRef[],
): { apps: SuggestedEnvGroup[]; services: SuggestedEnvGroup[] } {
    const target = apps.find((app) => app.primary === true) ?? apps[0];
    if (target == null) return groups;

    const urlServices = services.filter((service) => recipeSupportsUrlToken(service.recipe));
    if (urlServices.length === 0) return groups;

    const appGroups = groups.apps.map((group) => ({ name: group.name, vars: [...group.vars] }));
    const referencedTokens = new Set(
        appGroups.flatMap((group) => group.vars.map((entry) => entry.reference).filter((ref) => ref != null)),
    );

    let primaryGroup = appGroups.find((group) => group.name === target.name);
    const primaryKeys = new Set(primaryGroup?.vars.map((entry) => entry.key));
    for (const service of urlServices) {
        const token = `{{${service.name}.url}}`;
        if (referencedTokens.has(token)) continue;
        const connectionVar = connectionVarForService(service);
        if (primaryKeys.has(connectionVar.key)) continue;
        if (primaryGroup == null) {
            primaryGroup = { name: target.name, vars: [] };
            appGroups.push(primaryGroup);
        }
        primaryGroup.vars.push(connectionVar);
        primaryKeys.add(connectionVar.key);
        referencedTokens.add(token);
    }

    return { apps: appGroups, services: groups.services };
}

function connectionVarForService(service: SuggestionServiceRef): SuggestedEnvVar {
    return {
        key: connectionEnvKeyForRecipe(service.recipe),
        reference: `{{${service.name}.url}}`,
        sensitive: false,
        confidence: "high",
        evidence: [`managed service: ${service.name}`],
        description: `Connection URL for the ${service.name} service.`,
    };
}

/** Canonical connection env key per URL-exposing recipe (only called for those recipes). */
function connectionEnvKeyForRecipe(recipe: SuggestableServiceRecipe): string {
    if (recipe === "postgres") return "DATABASE_URL";
    if (recipe === "mongodb") return "MONGO_URL";
    return "REDIS_URL";
}

function heuristicEnvVar(entry: DotenvEntry, services: SuggestionServiceRef[]): SuggestedEnvVar {
    const reference = referenceForEnvKey(entry.key, services);
    const suggestion: SuggestedEnvVar = {
        key: entry.key,
        // Only a value that wires to a service (a `{{...}}` reference) is a
        // connection (sensitive=false). Every other value is a write-only secret
        // on this platform, so it carries no literal value - the user fills it in.
        sensitive: reference == null,
        confidence: "medium",
        evidence: [".env.example"],
    };
    if (reference != null) suggestion.reference = reference;
    if (isBuildTimeKey(entry.key)) suggestion.build_time = true;
    if (entry.comment != null) suggestion.description = entry.comment;
    return suggestion;
}

/** Whether a key's value is inlined at build time (framework client-bundle vars). */
function isBuildTimeKey(key: string): boolean {
    return BUILD_TIME_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** The `{{name.field}}` tokens a service exposes, mirroring the UI's `serviceRecipeSupportsUrlToken`. */
function referenceTokensForService(service: SuggestionServiceRef): string[] {
    const hostPort = [`{{${service.name}.host}}`, `{{${service.name}.port}}`];
    return recipeSupportsUrlToken(service.recipe) ? [`{{${service.name}.url}}`, ...hostPort] : hostPort;
}

function referenceForEnvKey(key: string, services: SuggestionServiceRef[]): string | undefined {
    const recipe = mapEnvKeyToRecipe(key);
    if (recipe == null) return undefined;
    const service = services.find((candidate) => candidate.recipe === recipe);
    if (service == null) return undefined;
    // Recipes with a connection URL wire via a single {{name.url}}; the rest
    // (temporal, upstash) have no URL token, so compose host:port.
    return recipeSupportsUrlToken(recipe)
        ? `{{${service.name}.url}}`
        : `{{${service.name}.host}}:{{${service.name}.port}}`;
}

function recipeSupportsUrlToken(recipe: SuggestableServiceRecipe): boolean {
    return recipe === "postgres" || recipe === "redis" || recipe === "valkey" || recipe === "mongodb";
}

function mapDependencyToRecipe(dep: string): SuggestableServiceRecipe | undefined {
    const normalized = dep.toLowerCase();
    for (const { recipe, deps } of DEPENDENCY_RECIPES) {
        if (deps.includes(normalized)) return recipe;
    }
    return undefined;
}

function mapImageToRecipe(image: string): SuggestableServiceRecipe | undefined {
    const normalized = image.toLowerCase();
    if (normalized.includes("postgres")) return "postgres";
    if (normalized.includes("valkey")) return "valkey";
    if (normalized.includes("redis")) return "redis";
    if (normalized.includes("mongo")) return "mongodb";
    if (normalized.includes("temporal")) return "temporal";
    return undefined;
}

function mapEnvKeyToRecipe(key: string): SuggestableServiceRecipe | undefined {
    const normalized = key.toUpperCase();
    if (normalized.includes("POSTGRES") || normalized === "DATABASE_URL" || normalized.startsWith("PG")) {
        return "postgres";
    }
    if (normalized.includes("MONGO")) return "mongodb";
    if (normalized.includes("REDIS")) return "redis";
    if (normalized.includes("TEMPORAL")) return "temporal";
    if (normalized.includes("UPSTASH")) return "upstash";
    return undefined;
}

function stripQuotes(value: string): string {
    if (value.length < 2) return value;
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
    return value;
}

/** Repo-relative path for a file inside an app dir; `.`/empty dirs resolve to the repo root. */
function joinRepoPath(dir: string, file: string): string {
    const trimmed = dir
        .trim()
        .replace(/^\.?\/*/, "")
        .replace(/\/+$/, "");
    if (trimmed === "") return file;
    return file === "" ? trimmed : `${trimmed}/${file}`;
}

function describeError(err: unknown): string {
    return err instanceof Error ? err.message : "Failed to read repository contents";
}
