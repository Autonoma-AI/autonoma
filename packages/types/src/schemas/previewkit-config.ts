import { z } from "zod";
import { isReservedPreviewkitEnvKey } from "./previewkit-builtins";
import { PREVIEWKIT_RUNTIME_IDS } from "./previewkit-runtimes";
import { SecretKeySchema } from "./secrets";

export interface ContainerResources {
    cpu: string;
    memoryRequest: string;
    memoryLimit: string;
}

export const STANDARD_RESOURCES = {
    app: { cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" },
    service: { cpu: "100m", memoryRequest: "256Mi", memoryLimit: "1Gi" },
} as const;

export type PreviewResourceRole = keyof typeof STANDARD_RESOURCES;

const k8sNameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * Per-container `resources` input. `cpu` and `memory` are the client-facing
 * knobs; the normalized `memoryRequest` / `memoryLimit` keys are accepted too so
 * that re-parsing an already-resolved config is idempotent (the merged config is
 * re-validated at deploy time after crossing the Temporal activity boundary).
 *
 * Whether these values take effect is decided by the config's source, not the
 * field itself - see {@link buildResourcesSchema}.
 */
const resourcesInput = z
    .object({
        cpu: z.string().optional(),
        memory: z.string().optional(),
        memoryRequest: z.string().optional(),
        memoryLimit: z.string().optional(),
    })
    .optional();

/**
 * Builds the `resources` schema for one container tier. The trust boundary lives
 * here: per-app/service resource sizing is honored only for trusted,
 * platform-authored config, never for untrusted client input (so onboarding
 * users can't set unbounded budgets for their own preview).
 *
 * - `allowCustomResources === false` (untrusted client input): client input is
 *   discarded; every container gets the standard {@link STANDARD_RESOURCES} tier
 *   for its role. The field is still accepted so existing configs keep validating.
 * - `allowCustomResources === true` (trusted platform-authored config): client
 *   `cpu` / `memory` are honored, each missing field falling back to the tier standard.
 *   `memory` sets both the request and the limit unless the normalized
 *   `memoryRequest` / `memoryLimit` are present (the deploy-time re-parse).
 */
function buildResourcesSchema(role: PreviewResourceRole, allowCustomResources: boolean) {
    return resourcesInput.transform((input) => {
        if (!allowCustomResources || input == null) {
            return standardResources(role);
        }
        const tier = STANDARD_RESOURCES[role];
        return {
            cpu: input.cpu ?? tier.cpu,
            memoryRequest: input.memoryRequest ?? input.memory ?? tier.memoryRequest,
            memoryLimit: input.memoryLimit ?? input.memory ?? tier.memoryLimit,
        };
    });
}

// `appSchema` and `serviceSchema` are built inside `buildPreviewConfigSchema`
// (below) so their `resources` tier can be gated by `allowCustomResources`.

const addonSchema = z.object({
    name: z.string().regex(k8sNameRegex, "Must be a valid Kubernetes name"),
    provider: z.string().min(1, "provider is required"),
    auth_secret: z.string().min(1, "auth_secret is required"),
    options: z.record(z.string(), z.unknown()).default({}),
});

const branchConventionSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("same_branch_name") }),
    z.object({
        type: z.literal("regex"),
        pattern: z.string().refine((pattern) => {
            try {
                new RegExp(pattern);
                return true;
            } catch {
                return false;
            }
        }, "Invalid regular expression pattern"),
        replacement: z.string(),
    }),
    z.object({ type: z.literal("manual") }),
]);

const repoDependencySchema = z.object({
    name: z.string().regex(k8sNameRegex, "Must be a valid Kubernetes name"),
    repo: z.string(),
    fallback_branch: z.string().default("main"),
    /**
     * The concrete commit SHA the dependency was deployed at. Absent in
     * user-authored config: previewkit resolves the dependency's branch to a
     * commit at deploy time and records it here by enriching the stored
     * `resolvedConfig` (deploy provenance, not authored input). Multi-repo
     * grounding reads this back to inspect the exact code that was live.
     */
    sha: z.string().optional(),
});

const multirepoConfigSchema = z.object({
    branch_convention: branchConventionSchema.optional(),
    repos: z.array(repoDependencySchema).default([]),
});

const configSchema = z.object({
    multirepo: multirepoConfigSchema.optional(),
});

// A pre/post-deploy hook step. Every hook runs as a one-off Kubernetes Job
// built from the target app's image (see previewkit's hook-job-runner); there
// is no in-pod exec variant.
const hookStepSchema = z.object({
    app: z.string(),
    command: z.string(),
});

const hooksSchema = z
    .object({
        pre_deploy: z.array(hookStepSchema).default([]),
        post_deploy: z.array(hookStepSchema).default([]),
    })
    .default({ pre_deploy: [], post_deploy: [] });

/**
 * The database engines offered in the onboarding Database step. Each maps to a
 * service recipe of the same name (see apps/previewkit `recipes/`): a database
 * is stored as a `service` whose `recipe` is one of these, so it provisions
 * through the same tested recipe machinery as every other service and is a
 * `{{name.host}}` connection target for free. Valkey is its own recipe (a
 * drop-in Redis) rather than a variant of `redis`.
 */
export const PREVIEWKIT_DATABASE_ENGINES = ["postgres", "mysql", "mongodb", "redis", "valkey"] as const;
export type PreviewkitDatabaseEngine = (typeof PREVIEWKIT_DATABASE_ENGINES)[number];

export function isPreviewkitDatabaseEngine(recipe: string): recipe is PreviewkitDatabaseEngine {
    const engines: readonly string[] = PREVIEWKIT_DATABASE_ENGINES;
    return engines.includes(recipe);
}

/**
 * Where a database setup task runs. The repo is always checked out so the task
 * can read files that live in the repo (a `db/schema.sql`, a `migrate` script)
 * rather than in the production database image.
 * - `in_build`: rides an app's build container - the repo is already checked
 *   out there and the build output is available - running before or after that
 *   app's build step.
 * - `separate_job`: its own throwaway container with a fresh checkout of the
 *   chosen repo (`repo` names a connected repo from `config.multirepo.repos`;
 *   absent = the primary repo), independent of any app build.
 *
 * NOTE: the runner does not yet honor `type` / `position` / `repo` - every task
 * currently runs as a standalone job from the primary app's image between infra
 * and app deploy. These fields are persisted for when that wiring lands.
 */
const databaseSetupLocationSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("in_build"),
        app: z.string().min(1, "an app is required for an in-build task"),
        position: z.enum(["before", "after"]),
    }),
    z.object({
        type: z.literal("separate_job"),
        repo: z.string().optional(),
    }),
]);

/**
 * A single database setup command (schema creation, seed data, or a migration).
 * `frequency` separates one-time setup (`on_create`, e.g. table creation and
 * initial seed) from per-deploy setup (`every_commit`, e.g. migrations). Runs
 * with the repo checked out; see {@link databaseSetupLocationSchema} for where.
 */
const databaseSetupTaskSchema = z.object({
    command: z.string(),
    frequency: z.enum(["on_create", "every_commit"]),
    location: databaseSetupLocationSchema,
});

// `build` selects an app's build strategy, discriminated on `framework`:
// - node / bun / next / vite: previewkit generates a Dockerfile from the
//   install / build / run commands (defaulted from the framework + package
//   manager + build context, each overridable).
// - dockerfile: build a user-authored Dockerfile at the given path. `target`
//   selects a stage in a multi-stage Dockerfile (buildctl `--opt target=`),
//   matching `docker build --target`. Without it, buildkit builds the LAST
//   stage - which silently builds the wrong service when a Dockerfile ends with
//   a worker/sidecar stage instead of the deployable one.
// - runtime: the raw escape hatch (see previewkit-runtimes.ts). The user picks a
//   language runtime or bare base image and writes a bash `build_script` +
//   `entrypoint`; the generator emits `FROM <image>` / `RUN <build_script>` /
//   `CMD <entrypoint>` with a tiered toolbelt, skipping all autodetection. It is
//   the most general generated build - the framework presets above are just this
//   with the base image and commands prefilled.
// When `build` is omitted the app's bare `dockerfile` field (or a Dockerfile on
// disk at the app path) is built via the same BuildKit Dockerfile path; there is
// no autodetection, and an app with neither a `build` block nor any Dockerfile
// fails the deploy with an actionable error. `build_context: root` builds from
// the repository root so workspace dependencies resolve - this, plus a
// turbo-filtered build/run command (filtered by the app's real workspace
// package name), is how turbo monorepos build (turbo is not a bespoke
// scenario - it is just `build_context: root` on a framework preset).
// Next.js `output: 'standalone'` is supported by setting an explicit
// `run_command` (e.g. `node apps/web/.next/standalone/server.js`); there is no
// autodetection of the next.config - the run command is the single source of
// truth for how the container starts.
const nodeVersionRegex = /^\d+(\.\d+)?(\.\d+)?$/;
const buildContextSchema = z.enum(["app", "root"]).default("app");

/**
 * Delimiter the previewkit generator uses for the raw `build_script` heredoc. A
 * script line exactly equal to it would close the heredoc early (build breakage /
 * generated-Dockerfile injection), so the schema rejects that below and the
 * generator reads this same constant - one source of truth.
 */
export const PREVIEWKIT_BUILD_SCRIPT_HEREDOC = "AUTONOMA_BUILD_EOF";

function nodeFrameworkBuildSchema<TFramework extends "node" | "next" | "vite">(framework: TFramework) {
    return z.object({
        framework: z.literal(framework),
        package_manager: z.enum(["npm", "pnpm", "yarn"]).default("pnpm"),
        node_version: z.string().regex(nodeVersionRegex, "must look like 22, 22.5, or 22.5.0").default("22"),
        install_command: z.string().min(1).optional(),
        build_command: z.string().min(1).optional(),
        run_command: z.string().min(1).optional(),
        build_context: buildContextSchema,
    });
}

const buildSchema = z.discriminatedUnion("framework", [
    nodeFrameworkBuildSchema("node"),
    nodeFrameworkBuildSchema("next"),
    nodeFrameworkBuildSchema("vite"),
    z.object({
        framework: z.literal("bun"),
        install_command: z.string().min(1).optional(),
        build_command: z.string().min(1).optional(),
        run_command: z.string().min(1).optional(),
        build_context: buildContextSchema,
    }),
    z.object({
        framework: z.literal("dockerfile"),
        dockerfile: z.string().min(1, "dockerfile path is required"),
        target: z.string().min(1).optional(),
        build_context: buildContextSchema,
    }),
    z.object({
        framework: z.literal("runtime"),
        runtime: z.enum(PREVIEWKIT_RUNTIME_IDS),
        // Image tag version, e.g. "22" for node. Optional - defaults to the
        // catalog's default per runtime. The user picks it so a repo pinned to an
        // older toolchain is not forced onto our default (which would defeat the
        // escape hatch). Constrained to a safe tag charset so it can never break
        // out of the generated `FROM` line.
        version: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a valid image tag")
            .optional(),
        // Both are raw bash. `build_script` bakes into the image (cached); the
        // entrypoint is the container start command. `build_script` is optional
        // (some apps need no build step); `entrypoint` is required - the
        // container has to start somehow. `app.command` still overrides it at
        // deploy time.
        build_script: z
            .string()
            .min(1)
            .refine(
                (script) => !script.split("\n").includes(PREVIEWKIT_BUILD_SCRIPT_HEREDOC),
                `build script cannot contain a line equal to "${PREVIEWKIT_BUILD_SCRIPT_HEREDOC}" (reserved heredoc delimiter)`,
            )
            .optional(),
        // The entrypoint is baked verbatim into a single-line `CMD`, so a newline
        // would break out of the CMD and inject a bogus Dockerfile instruction
        // (e.g. "npm start\nnode server.js"). Constrain it to one line; use a
        // start script referenced from here if you need multiple commands.
        entrypoint: z
            .string()
            .min(1, "entrypoint is required")
            .regex(/^[^\r\n]+$/, "entrypoint must be a single line (no line breaks)"),
        build_context: buildContextSchema,
    }),
]);

/**
 * A runtime environment variable whose value is wired to the topology. Unlike a
 * secret, a connection has no static value: its `value` is a template that
 * references other apps/services via `{{name.property}}` tokens and is resolved
 * at deploy time by the EnvInjector. It is never sensitive and never stored in
 * AWS. The value can combine multiple tokens and literal text, e.g.
 * `mongodb://{{db.host}}:{{db.port}}/preview` or `{{temporal.host}}:{{temporal.port}}` -
 * which a single service/property pair could not express. `build_time` also
 * passes the resolved value as a Docker build arg.
 */
const connectionSchema = z.object({
    key: SecretKeySchema.superRefine((key, ctx) => {
        if (isReservedPreviewkitEnvKey(key)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `${key} is a reserved built-in variable and cannot be set.`,
            });
        }
    }).describe("The env var name to inject into the app at runtime (e.g. DATABASE_URL)."),
    value: z
        .string()
        .min(1, "value is required")
        .describe(
            "Template resolved at deploy time. {{name.property}} tokens reference apps/services/addons in this " +
                "config by name. For a service: {{db.url}} = the full canonical connection string (postgres -> " +
                "postgresql://preview:preview@<host>:<port>/preview; redis -> redis://...; mongodb -> " +
                "mongodb://...), {{db.host}} = in-cluster DNS name, {{db.port}}. For an app: {{api.url}} = its " +
                "public HTTPS URL, {{api.hostname}}. For an addon: {{name.<outputKey>}} (e.g. a Neon " +
                "connectionString). Also available: {{pr}}, {{namespace}}, {{owner}}. Tokens can mix with literal " +
                "text ('postgresql://user:pass@{{db.host}}:5432/mydb'), or be a plain literal ('production'). " +
                "Prefer {{db.url}} to wire a database.",
        ),
    build_time: z.boolean().default(false).describe("Also pass the resolved value as a Docker build arg."),
});

/**
 * Builds the preview config schema. `allowCustomResources` is the only knob: it
 * decides whether per-app/service `resources` overrides are honored (trusted,
 * platform-authored config) or discarded in favor of the standard tier (untrusted
 * client input). Every other validation rule is identical. See
 * {@link buildResourcesSchema}.
 */
function buildPreviewConfigSchema(allowCustomResources: boolean) {
    const appSchema = z.object({
        name: z.string().regex(k8sNameRegex, "Must be a valid Kubernetes name"),
        path: z.string().default("."),
        build_context: z.string().optional(),
        dockerfile: z.string().optional(),
        build: buildSchema.optional(),
        // The AWS-secret keys to also inject at build time (Docker build args).
        // Runtime secret values live in AWS Secrets Manager, never in this document.
        build_secrets: z.array(z.string()).default([]),
        port: z.number().int().positive(),
        // Non-secret variables wired to the topology, resolved at deploy time.
        // All user-typed values are secrets (AWS), so they never appear here.
        connections: z.array(connectionSchema).default([]),
        command: z.string().optional(),
        health_check: z.string().optional(),
        primary: z.boolean().optional(),
        resources: buildResourcesSchema("app", allowCustomResources),
        depends_on: z.array(z.string()).optional(),
    });

    const serviceSchema = z.object({
        name: z.string().regex(k8sNameRegex, "Must be a valid Kubernetes name"),
        recipe: z.string(),
        version: z.string().optional(),
        // Recipe-functional knobs (e.g. postgres user/database, or a docker-image
        // service's image/ports/env) live in `options`, validated per-recipe.
        options: z.record(z.string(), z.unknown()).default({}),
        // Guided setup for database-recipe services (schema, seed, migrations),
        // run with the repo checked out. Empty for non-database services.
        setup_tasks: z.array(databaseSetupTaskSchema).default([]),
        resources: buildResourcesSchema("service", allowCustomResources),
        s3: z.boolean().optional(),
        sqs: z.boolean().optional(),
        sns: z.boolean().optional(),
    });

    return z
        .object({
            version: z.literal(1),
            domain: z.string().optional(),
            registry: z.string().optional(),
            config: configSchema.optional(),
            apps: z.array(appSchema).min(1, "At least one app is required"),
            services: z.array(serviceSchema).default([]),
            addons: z.array(addonSchema).default([]),
            hooks: hooksSchema,
        })
        .superRefine((cfg, ctx) => {
            const seen = new Map<string, "app" | "service" | "addon">();
            const check = (name: string, kind: "app" | "service" | "addon") => {
                const existing = seen.get(name);
                if (existing != null) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: `Name "${name}" is used by both a ${existing} and an ${kind} - names must be unique across apps, services, and addons`,
                    });
                    return;
                }
                seen.set(name, kind);
            };
            for (const app of cfg.apps) check(app.name, "app");
            for (const service of cfg.services) check(service.name, "service");
            for (const addon of cfg.addons) check(addon.name, "addon");
        });
}

/**
 * The untrusted client-config contract (e.g. the dashboard authoring form).
 * Per-app/service `resources` overrides are accepted but ignored here (every
 * container gets the standard tier); untrusted input cannot size its own
 * preview. Use this for any client-supplied config.
 */
export const previewConfigSchema = buildPreviewConfigSchema(false);

/**
 * Variant that honors per-app/service `resources` overrides. Use ONLY for
 * trusted, platform-authored config: the stored DB config document and the
 * deploy-time re-parse of an already-resolved merged config. NEVER parse
 * untrusted client input with this - that path must use {@link previewConfigSchema}.
 */
export const trustedPreviewConfigSchema = buildPreviewConfigSchema(true);

// Both variants produce the same shape (resources is always the normalized
// `{ cpu, memoryRequest, memoryLimit }`); only the source of the values differs.
export type PreviewConfig = z.infer<typeof previewConfigSchema>;
export type AppConfig = PreviewConfig["apps"][number];
export type Connection = z.infer<typeof connectionSchema>;

/** A `{{target.property}}` connection token parsed into its parts. */
export interface ConnectionToken {
    target: string;
    property: string;
}

// Matches a value that is EXACTLY one `{{target.property}}` reference token.
const CONNECTION_TOKEN_PATTERN = /^\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}$/;

/**
 * Parses a value that is exactly one `{{target.property}}` connection token, or
 * undefined when the value is anything else.
 */
export function parseConnectionToken(value: string): ConnectionToken | undefined {
    const match = CONNECTION_TOKEN_PATTERN.exec(value.trim());
    const target = match?.[1];
    const property = match?.[2];
    if (target == null || property == null) return undefined;
    return { target, property };
}

// Finds every `{{target.property}}` token anywhere in a value (a connection
// value may combine several tokens plus literal text).
const CONNECTION_TOKEN_GLOBAL = /\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}/g;

/** The distinct app/service names a connection value references via `{{name.property}}`. */
export function connectionTargets(value: string): string[] {
    const targets = new Set<string>();
    for (const match of value.matchAll(CONNECTION_TOKEN_GLOBAL)) {
        if (match[1] != null) targets.add(match[1]);
    }
    return [...targets];
}

/** Every `{{target.property}}` token in a connection value, in order (duplicates kept). */
export function connectionTokens(value: string): ConnectionToken[] {
    const tokens: ConnectionToken[] = [];
    for (const match of value.matchAll(CONNECTION_TOKEN_GLOBAL)) {
        if (match[1] != null && match[2] != null) tokens.push({ target: match[1], property: match[2] });
    }
    return tokens;
}

/** Whether a connection value contains at least one `{{name.property}}` token. */
export function hasConnectionToken(value: string): boolean {
    return connectionTargets(value).length > 0;
}

/** An app's build strategy. Discriminated union on `framework`. */
export type Build = z.infer<typeof buildSchema>;
export type BuildFramework = Build["framework"];

export type ConfigIssueSeverity = "error" | "warning";

export type ConfigIssueCode =
    | "schema"
    | "unknown_depends_on"
    | "self_depends_on"
    | "unknown_hook_app"
    | "empty_hook_app"
    | "empty_hook_command"
    | "no_primary"
    | "multiple_primary"
    | "duplicate_name"
    | "unknown_connection_target"
    | "duplicate_connection_key"
    | "unreferenced_database_service"
    | "empty_setup_task_command"
    | "unknown_setup_task_app"
    | "unknown_setup_task_repo"
    | "path_not_found"
    | "dockerfile_not_found";

export type HookGroupKey = "pre_deploy" | "post_deploy";

/**
 * A single validation finding on a PreviewKit config document. `path` is a Zod-style
 * path into the document (e.g. `["apps", 0, "depends_on", 1]`) so UIs can map the
 * issue back to the exact form field. `error`-severity issues block save/deploy;
 * `warning`-severity issues are surfaced but never block.
 */
export interface ConfigIssue {
    severity: ConfigIssueSeverity;
    code: ConfigIssueCode;
    path: Array<string | number>;
    message: string;
}

/** Maps Zod parse issues onto {@link ConfigIssue}s so schema and semantic findings share one shape. */
export function zodIssuesToConfigIssues(error: z.ZodError): ConfigIssue[] {
    return error.issues.map((issue) => ({
        severity: "error",
        code: "schema",
        // Zod types path segments as PropertyKey; symbols never occur in JSON documents.
        path: issue.path.filter((segment): segment is string | number => typeof segment !== "symbol"),
        message: issue.message,
    }));
}

/**
 * Semantic checks layered on top of `previewConfigSchema` (which already enforces
 * shape, ports, and name uniqueness within one document). Pure - safe to run on
 * both the API and the dashboard. Returns an empty array for a clean config.
 */
export function validatePreviewConfigSemantics(config: PreviewConfig): ConfigIssue[] {
    const issues: ConfigIssue[] = [];
    const names = new Set<string>([
        ...config.apps.map((app) => app.name),
        ...config.services.map((service) => service.name),
        ...config.addons.map((addon) => addon.name),
    ]);
    const appNames = new Set(config.apps.map((app) => app.name));

    config.apps.forEach((app, appIndex) => {
        (app.depends_on ?? []).forEach((dependency, depIndex) => {
            if (dependency === app.name) {
                issues.push({
                    severity: "error",
                    code: "self_depends_on",
                    path: ["apps", appIndex, "depends_on", depIndex],
                    message: `App "${app.name}" cannot depend on itself`,
                });
                return;
            }
            if (!names.has(dependency)) {
                issues.push({
                    severity: "error",
                    code: "unknown_depends_on",
                    path: ["apps", appIndex, "depends_on", depIndex],
                    message: `"${dependency}" does not match any app or service in this config`,
                });
            }
        });

        const seenConnectionKeys = new Set<string>();
        app.connections.forEach((connection, connectionIndex) => {
            for (const target of connectionTargets(connection.value)) {
                if (!names.has(target)) {
                    issues.push({
                        severity: "error",
                        code: "unknown_connection_target",
                        path: ["apps", appIndex, "connections", connectionIndex, "value"],
                        message: `"{{${target}...}}" does not match any app or service in this config`,
                    });
                }
            }
            if (seenConnectionKeys.has(connection.key)) {
                issues.push({
                    severity: "error",
                    code: "duplicate_connection_key",
                    path: ["apps", appIndex, "connections", connectionIndex, "key"],
                    message: `Connection "${connection.key}" is defined more than once`,
                });
            }
            seenConnectionKeys.add(connection.key);
        });
    });

    const primaryIndexes = config.apps.flatMap((app, index) => (app.primary === true ? [index] : []));
    if (primaryIndexes.length === 0) {
        issues.push({
            severity: "warning",
            code: "no_primary",
            path: ["apps"],
            message: "No app is marked as primary - the first app will be treated as the primary preview URL",
        });
    } else if (primaryIndexes.length > 1) {
        for (const index of primaryIndexes.slice(1)) {
            issues.push({
                severity: "error",
                code: "multiple_primary",
                path: ["apps", index, "primary"],
                message: "Only one app can be marked as primary",
            });
        }
    }

    const repoNames = new Set((config.config?.multirepo?.repos ?? []).map((repo) => repo.name));
    config.services.forEach((service, serviceIndex) => {
        issues.push(...validateSetupTasks(service.setup_tasks, appNames, repoNames, serviceIndex));
    });

    // A database service no app connection references is almost always a wiring
    // gap: the database provisions and comes up healthy, but the apps have no env
    // pointing at it, so the first runtime query fails ("DATABASE_URL not found")
    // AFTER the deploy reports ready. Warn - never block - since an app could
    // reach the service through a channel this validation can't see.
    const referencedTargets = new Set(
        config.apps.flatMap((app) => app.connections.flatMap((connection) => connectionTargets(connection.value))),
    );
    config.services.forEach((service, serviceIndex) => {
        if (!isPreviewkitDatabaseEngine(service.recipe) || referencedTargets.has(service.name)) return;
        issues.push({
            severity: "warning",
            code: "unreferenced_database_service",
            path: ["services", serviceIndex],
            message:
                `Service "${service.name}" (${service.recipe}) is not referenced by any app connection - ` +
                `your apps have no env pointing at it. Add a connection like ` +
                `{ key: "DATABASE_URL", value: "{{${service.name}.url}}" } to the app that uses it.`,
        });
    });

    issues.push(...validateHookSteps(config.hooks.pre_deploy, appNames, "pre_deploy"));
    issues.push(...validateHookSteps(config.hooks.post_deploy, appNames, "post_deploy"));

    return issues;
}

/**
 * Validates one service's database setup tasks. A task is invalid when it has no
 * command, an `in_build` task names an app that isn't declared, or a
 * `separate_job` task names a connected repo that isn't declared in
 * `config.multirepo.repos`. Shared by the semantic validator and the dashboard's
 * database editor so client and server apply the same rules.
 */
export function validateSetupTasks(
    tasks: ReadonlyArray<z.infer<typeof databaseSetupTaskSchema>>,
    appNames: ReadonlySet<string>,
    repoNames: ReadonlySet<string>,
    serviceIndex: number,
): ConfigIssue[] {
    const issues: ConfigIssue[] = [];
    tasks.forEach((task, index) => {
        const base = ["services", serviceIndex, "setup_tasks", index];
        if (task.command.trim() === "") {
            issues.push({
                severity: "error",
                code: "empty_setup_task_command",
                path: [...base, "command"],
                message: "Setup task is missing a command",
            });
        }
        if (task.location.type === "in_build" && !appNames.has(task.location.app)) {
            issues.push({
                severity: "error",
                code: "unknown_setup_task_app",
                path: [...base, "location", "app"],
                message: `Setup task references unknown app "${task.location.app}"`,
            });
        }
        if (task.location.type === "separate_job" && task.location.repo != null && !repoNames.has(task.location.repo)) {
            issues.push({
                severity: "error",
                code: "unknown_setup_task_repo",
                path: [...base, "location", "repo"],
                message: `Setup task references unknown repository "${task.location.repo}"`,
            });
        }
    });
    return issues;
}

/**
 * Validates one group of deploy hooks. A hook is invalid when it is missing its
 * target app, names an app that isn't declared in the config, or is missing the
 * command to run. A fully-blank row (no app and no command) is ignored - the
 * authoring UI drops those before save, and they carry no intent. Shared by the
 * semantic validator above and the dashboard's hooks editor so client and server
 * apply the exact same rules.
 */
export function validateHookSteps(
    steps: ReadonlyArray<{ app: string; command: string }>,
    appNames: ReadonlySet<string>,
    group: HookGroupKey,
): ConfigIssue[] {
    const issues: ConfigIssue[] = [];
    steps.forEach((step, index) => {
        const app = step.app.trim();
        const command = step.command.trim();
        if (app === "" && command === "") return;

        if (app === "") {
            issues.push({
                severity: "error",
                code: "empty_hook_app",
                path: ["hooks", group, index, "app"],
                message: "Hook is missing an app",
            });
        } else if (!appNames.has(app)) {
            issues.push({
                severity: "error",
                code: "unknown_hook_app",
                path: ["hooks", group, index, "app"],
                message: `Hook references unknown app "${app}"`,
            });
        }

        if (command === "") {
            issues.push({
                severity: "error",
                code: "empty_hook_command",
                path: ["hooks", group, index, "command"],
                message: "Hook is missing a command",
            });
        }
    });
    return issues;
}

function standardResources(role: PreviewResourceRole): ContainerResources {
    const standard = STANDARD_RESOURCES[role];
    return {
        cpu: standard.cpu,
        memoryRequest: standard.memoryRequest,
        memoryLimit: standard.memoryLimit,
    };
}
export type ServiceConfig<TOptions = Record<string, unknown>> = Omit<PreviewConfig["services"][number], "options"> & {
    options: TOptions;
};
export type DatabaseSetupTask = z.infer<typeof databaseSetupTaskSchema>;
export type DatabaseSetupLocation = z.infer<typeof databaseSetupLocationSchema>;
export type AddonConfig = z.infer<typeof addonSchema>;
export type BranchConvention = z.infer<typeof branchConventionSchema>;
export type RepoDependency = z.infer<typeof repoDependencySchema>;
