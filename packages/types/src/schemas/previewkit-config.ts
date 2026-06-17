import { z } from "zod";

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

export const MAX_REPLICAS = 3;

const k8sNameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * Deprecated config field: user-provided CPU/memory values are accepted so
 * existing `.preview.yaml` files continue to validate, but they are ignored.
 * PreviewKit owns container budgets centrally to keep preview namespaces
 * predictable and prevent onboarding users from setting unbounded resources.
 */
const appResourcesSchema = z
    .unknown()
    .optional()
    .transform(() => standardResources("app"));

/**
 * Deprecated config field: service resources follow the same compatibility
 * policy as app resources, but resolve to the smaller service-tier budget.
 */
const serviceResourcesSchema = z
    .unknown()
    .optional()
    .transform(() => standardResources("service"));

const appSchema = z.object({
    name: z.string().regex(k8sNameRegex, "Must be a valid Kubernetes name"),
    path: z.string().default("."),
    build_context: z.string().optional(),
    dockerfile: z.string().optional(),
    monorepo: z.enum(["turbo"]).optional(),
    build_args: z.record(z.string(), z.string()).default({}),
    build_secrets: z.array(z.string()).default([]),
    port: z.number().int().positive(),
    env: z.record(z.string(), z.string()).default({}),
    command: z.string().optional(),
    health_check: z.string().optional(),
    replicas: z
        .number()
        .int()
        .positive()
        .default(1)
        .transform((replicas) => Math.min(replicas, MAX_REPLICAS)),
    primary: z.boolean().optional(),
    resources: appResourcesSchema,
    depends_on: z.array(z.string()).optional(),
});

const serviceSchema = z.object({
    name: z.string().regex(k8sNameRegex, "Must be a valid Kubernetes name"),
    recipe: z.string(),
    version: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
    options: z.record(z.string(), z.unknown()).default({}),
    resources: serviceResourcesSchema,
    s3: z.boolean().optional(),
    sqs: z.boolean().optional(),
    sns: z.boolean().optional(),
});

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
});

const multirepoConfigSchema = z.object({
    branch_convention: branchConventionSchema.optional(),
    repos: z.array(repoDependencySchema).default([]),
});

const configSchema = z.object({
    multirepo: multirepoConfigSchema.optional(),
});

const hookStepSchema = z.object({
    app: z.string(),
    command: z.string(),
    type: z.enum(["exec", "job"]).default("exec"),
});

const hooksSchema = z
    .object({
        pre_deploy: z.array(hookStepSchema).default([]),
        post_deploy: z.array(hookStepSchema).default([]),
    })
    .default({ pre_deploy: [], post_deploy: [] });

export const previewConfigSchema = z
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

export type PreviewConfig = z.infer<typeof previewConfigSchema>;
export type AppConfig = z.infer<typeof appSchema>;

export type ConfigIssueSeverity = "error" | "warning";

export type ConfigIssueCode =
    | "schema"
    | "unknown_depends_on"
    | "self_depends_on"
    | "unknown_hook_app"
    | "no_primary"
    | "multiple_primary"
    | "duplicate_name"
    | "unknown_env_reference"
    | "path_not_found"
    | "dockerfile_not_found";

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

// Matches `{{name.field}}` template references. Single-word builtins like `{{pr}}`
// and `{{namespace}}` have no dot and are intentionally not matched.
const ENV_REFERENCE_PATTERN = /\{\{\s*([a-z0-9][a-z0-9-]*)\.([a-zA-Z0-9_.-]+)\s*\}\}/g;

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

        for (const [key, value] of Object.entries(app.env)) {
            for (const match of value.matchAll(ENV_REFERENCE_PATTERN)) {
                const referencedName = match[1];
                if (referencedName != null && !names.has(referencedName)) {
                    issues.push({
                        severity: "warning",
                        code: "unknown_env_reference",
                        path: ["apps", appIndex, "env", key],
                        message: `"{{${referencedName}.${match[2]}}}" does not reference a declared app, service, or addon`,
                    });
                }
            }
        }
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

    const hookGroups = [
        { key: "pre_deploy", steps: config.hooks.pre_deploy },
        { key: "post_deploy", steps: config.hooks.post_deploy },
    ];
    for (const group of hookGroups) {
        group.steps.forEach((step, stepIndex) => {
            if (!appNames.has(step.app)) {
                issues.push({
                    severity: "error",
                    code: "unknown_hook_app",
                    path: ["hooks", group.key, stepIndex, "app"],
                    message: `Hook references unknown app "${step.app}"`,
                });
            }
        });
    }

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
export type ServiceConfig<TOptions = Record<string, unknown>> = Omit<z.infer<typeof serviceSchema>, "options"> & {
    options: TOptions;
};
export type AddonConfig = z.infer<typeof addonSchema>;
export type BranchConvention = z.infer<typeof branchConventionSchema>;
export type RepoDependency = z.infer<typeof repoDependencySchema>;
