import { z } from "zod";

const k8sNameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

const resourcesSchema = z
    .object({
        cpu: z.string().default("250m"),
        memory: z.string().default("256Mi"),
    })
    .default({ cpu: "250m", memory: "256Mi" });

const appSchema = z.object({
    name: z.string().regex(k8sNameRegex, "Must be a valid Kubernetes name"),
    path: z.string().default("."),
    build_context: z.string().optional(),
    dockerfile: z.string().optional(),
    build_args: z.record(z.string(), z.string()).default({}),
    build_secrets: z.array(z.string()).default([]),
    port: z.number().int().positive(),
    env: z.record(z.string(), z.string()).default({}),
    command: z.string().optional(),
    health_check: z.string().optional(),
    replicas: z.number().int().positive().default(1),
    primary: z.boolean().optional(),
    resources: resourcesSchema,
    depends_on: z.array(z.string()).optional(),
});

const serviceSchema = z.object({
    name: z.string().regex(k8sNameRegex, "Must be a valid Kubernetes name"),
    recipe: z.string(),
    version: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
    options: z.record(z.string(), z.unknown()).default({}),
    resources: resourcesSchema,
    // aws recipe
    s3: z.boolean().optional(),
    sqs: z.boolean().optional(),
    sns: z.boolean().optional(),
});

// Third-party resources provisioned via provider plugins (Neon, etc.).
// `auth_secret` references the name of a PreviewkitOrgSecret for the
// organization — the secret stores a JSON map and each provider's options
// schema picks the field it needs. `options` is forwarded verbatim to the
// provider, which validates it with its own zod schema.
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
        pattern: z.string().refine((p) => {
            try {
                new RegExp(p);
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
    // "exec" (default) runs the command inside a running pod via kubectl exec.
    // "job" creates a one-off K8s Job using the app's built image — use this
    // for pre_deploy migrations where the app pod hasn't started yet.
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
    // Names from apps/services/addons share one namespace: they all become
    // tokens in `{{name.<field>}}` templates and many become DNS labels in
    // K8s. Collisions would silently resolve to whichever pool the injector
    // checked first — reject them up front instead.
    .superRefine((cfg, ctx) => {
        const seen = new Map<string, "app" | "service" | "addon">();
        const check = (name: string, kind: "app" | "service" | "addon") => {
            const existing = seen.get(name);
            if (existing != null) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `Name "${name}" is used by both a ${existing} and an ${kind} — names must be unique across apps, services, and addons`,
                });
                return;
            }
            seen.set(name, kind);
        };
        for (const a of cfg.apps) check(a.name, "app");
        for (const s of cfg.services) check(s.name, "service");
        for (const a of cfg.addons) check(a.name, "addon");
    });

export type PreviewConfig = z.infer<typeof previewConfigSchema>;
export type AppConfig = z.infer<typeof appSchema>;
export type ServiceConfig<TOptions = Record<string, unknown>> = Omit<z.infer<typeof serviceSchema>, "options"> & {
    options: TOptions;
};
export type AddonConfig = z.infer<typeof addonSchema>;
export type BranchConvention = z.infer<typeof branchConventionSchema>;
export type RepoDependency = z.infer<typeof repoDependencySchema>;
