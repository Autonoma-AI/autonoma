import { z } from "zod";
import { isReservedPreviewkitEnvKey } from "./previewkit-builtins";
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

// `build` selects an app's build strategy, discriminated on `framework`:
// - node / bun / next / vite: previewkit generates a Dockerfile from the
//   install / build / run commands (defaulted from the framework + package
//   manager + build context, each overridable).
// - dockerfile: build a user-authored Dockerfile at the given path. `target`
//   selects a stage in a multi-stage Dockerfile (buildctl `--opt target=`),
//   matching `docker build --target`. Without it, buildkit builds the LAST
//   stage - which silently builds the wrong service when a Dockerfile ends with
//   a worker/sidecar stage instead of the deployable one.
// When `build` is omitted the pipeline falls back to Railpack autodetection
// (an on-disk Dockerfile still wins). `build_context: root` builds from the
// repository root so workspace dependencies resolve - this, plus a
// turbo-filtered build/run command, replaces the former `monorepo: turbo`.
const nodeVersionRegex = /^\d+(\.\d+)?(\.\d+)?$/;
const buildContextSchema = z.enum(["app", "root"]).default("app");

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
    }),
    value: z.string().min(1, "value is required"),
    build_time: z.boolean().default(false),
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
        monorepo: z.enum(["turbo"]).optional(),
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
        // Recipe-functional knobs (e.g. postgres user/database) live in `options`,
        // validated per-recipe. There is no free-text service env: it was an
        // unbounded plaintext bag, so it was removed.
        options: z.record(z.string(), z.unknown()).default({}),
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
 * trusted, platform-authored config: DB config revisions and the deploy-time
 * re-parse of an already-resolved merged config. NEVER parse untrusted client
 * input with this - that path must use {@link previewConfigSchema}.
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

    issues.push(...validateHookSteps(config.hooks.pre_deploy, appNames, "pre_deploy"));
    issues.push(...validateHookSteps(config.hooks.post_deploy, appNames, "post_deploy"));

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
export type AddonConfig = z.infer<typeof addonSchema>;
export type BranchConvention = z.infer<typeof branchConventionSchema>;
export type RepoDependency = z.infer<typeof repoDependencySchema>;
