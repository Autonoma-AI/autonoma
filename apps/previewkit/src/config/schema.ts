import { z } from "zod";
import { MAX_REPLICAS, STANDARD_RESOURCES } from "./index";

// Re-exported so existing importers can keep getting it from the schema
// module; the canonical definition now lives in the config index alongside the
// other platform-owned settings.
export { STANDARD_RESOURCES };

const k8sNameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * @deprecated Per-app/service resource sizing is no longer configurable -
 * every container gets the {@link STANDARD_RESOURCES} tier for its role
 * (`app` for application containers, `service` for recipe services).
 *
 * The field is still accepted so existing `.preview.yaml` files keep
 * validating, but any `cpu`/`memory` values are ignored: the schema
 * transform discards the input and always returns the standard allocation.
 * Remove `resources:` from your config; it has no effect.
 */
const ignoredResourcesInput = z
    .object({
        cpu: z.string().optional(),
        memory: z.string().optional(),
    })
    .optional();

const appResourcesSchema = ignoredResourcesInput.transform(() => ({
    cpu: STANDARD_RESOURCES.app.cpu,
    memoryRequest: STANDARD_RESOURCES.app.memoryRequest,
    memoryLimit: STANDARD_RESOURCES.app.memoryLimit,
}));

const serviceResourcesSchema = ignoredResourcesInput.transform(() => ({
    cpu: STANDARD_RESOURCES.service.cpu,
    memoryRequest: STANDARD_RESOURCES.service.memoryRequest,
    memoryLimit: STANDARD_RESOURCES.service.memoryLimit,
}));

const appSchema = z.object({
    name: z.string().regex(k8sNameRegex, "Must be a valid Kubernetes name"),
    path: z.string().default("."),
    build_context: z.string().optional(),
    dockerfile: z.string().optional(),
    // Names the workspace build tool when this app lives in a monorepo. When
    // set, the build runs from the repo root (not `path`) so railpack finds
    // the workspace lockfile, then invokes the tool with a filter for this
    // app. Currently supports "turbo" (bun/pnpm/yarn/npm + turbo).
    //
    // This is an enum rather than a boolean on purpose: "monorepo" is too
    // coarse a signal. A turbo+pnpm workspace, an nx workspace, a bazel
    // build, an sbt multi-project and a Cargo workspace are all "monorepos"
    // but each needs a completely different build invocation (turbo run
    // build --filter=... vs nx run-many vs bazel build //... vs sbt
    // <project>/compile). Encoding the tool in the value lets the dispatcher
    // route to a tool-specific build path without inventing a second field.
    // Adding "nx" / "bazel" later is a one-line enum extension plus a new
    // build method - existing configs are untouched.
    monorepo: z.enum(["turbo"]).optional(),
    build_args: z.record(z.string(), z.string()).default({}),
    build_secrets: z.array(z.string()).default([]),
    port: z.number().int().positive(),
    env: z.record(z.string(), z.string()).default({}),
    command: z.string().optional(),
    health_check: z.string().optional(),
    // Clamped to MAX_REPLICAS (platform policy): every replica multiplies the
    // standard allocation, so this is capped rather than client-tunable.
    // Out-of-range values are clamped, not rejected, so existing configs
    // keep validating.
    replicas: z
        .number()
        .int()
        .positive()
        .default(1)
        .transform((n) => Math.min(n, MAX_REPLICAS)),
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
