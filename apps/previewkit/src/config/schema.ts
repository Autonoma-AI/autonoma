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
    dockerfile: z.string().optional(),
    build_args: z.record(z.string(), z.string()).default({}),
    port: z.number().int().positive(),
    env: z.record(z.string(), z.string()).default({}),
    command: z.string().optional(),
    health_check: z.string().optional(),
    replicas: z.number().int().positive().default(1),
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
});

const hookStepSchema = z.object({
    app: z.string(),
    command: z.string(),
});

const hooksSchema = z
    .object({
        post_deploy: z.array(hookStepSchema).default([]),
    })
    .default({ post_deploy: [] });

export const previewConfigSchema = z.object({
    version: z.literal(1),
    domain: z.string().optional(),
    registry: z.string().optional(),
    apps: z.array(appSchema).min(1, "At least one app is required"),
    services: z.array(serviceSchema).default([]),
    hooks: hooksSchema,
});

export type PreviewConfig = z.infer<typeof previewConfigSchema>;
export type AppConfig = z.infer<typeof appSchema>;
export type ServiceConfig = z.infer<typeof serviceSchema>;
export type HookStep = z.infer<typeof hookStepSchema>;
