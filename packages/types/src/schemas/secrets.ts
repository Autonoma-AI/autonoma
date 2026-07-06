import { z } from "zod";
import { isManagedPreviewkitEnvKey, isReservedPreviewkitEnvKey } from "./previewkit-builtins";

const SECRET_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Mirrors the k8sNameRegex in apps/previewkit/src/config/schema.ts. Secret
// bundles are scoped to the same app names that appear in the preview config.
const APP_NAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export const SecretKeySchema = z
    .string()
    .min(1)
    .max(256)
    .regex(
        SECRET_KEY_REGEX,
        "Keys must start with a letter or underscore and contain only letters, numbers, and underscores",
    );

export const AppNameSchema = z
    .string()
    .min(2)
    .max(63)
    .regex(APP_NAME_REGEX, "App name must be lowercase alphanumeric with hyphens (Kubernetes label-compatible)");

export const SecretItemSchema = z.object({
    key: SecretKeySchema.superRefine((key, ctx) => {
        if (isReservedPreviewkitEnvKey(key)) {
            ctx.addIssue({
                code: "custom",
                message: `${key} is a reserved built-in variable and cannot be set.`,
            });
        } else if (isManagedPreviewkitEnvKey(key)) {
            ctx.addIssue({
                code: "custom",
                message: `${key} is a secret managed by Autonoma and cannot be set.`,
            });
        }
    }),
    value: z.string().min(1).max(65536),
});
export type SecretItem = z.infer<typeof SecretItemSchema>;

export const ListSecretAppsInputSchema = z.object({
    applicationId: z.string(),
});
export type ListSecretAppsInput = z.infer<typeof ListSecretAppsInputSchema>;

export const ListSecretsInputSchema = z.object({
    applicationId: z.string(),
    appName: AppNameSchema,
});
export type ListSecretsInput = z.infer<typeof ListSecretsInputSchema>;

export const UpsertSecretsInputSchema = z.object({
    applicationId: z.string(),
    appName: AppNameSchema,
    items: z.array(SecretItemSchema).min(1).max(200),
});
export type UpsertSecretsInput = z.infer<typeof UpsertSecretsInputSchema>;

export const DeleteSecretInputSchema = z.object({
    applicationId: z.string(),
    appName: AppNameSchema,
    key: SecretKeySchema,
});
export type DeleteSecretInput = z.infer<typeof DeleteSecretInputSchema>;

export type SecretSummary = {
    key: string;
    maskedLength: number;
    updatedAt: Date;
};

// Per-app secret changes batched alongside a preview-config save, so the editor
// can persist envs (config revision) and secrets (AWS Secrets Manager) in one
// "Save config" call. `upserts` reuse SecretItemSchema (reserved keys rejected);
// `deletes` are keys removed from the app's bundle.
export const PreviewkitConfigAppSecretsSchema = z.object({
    appName: AppNameSchema,
    upserts: z.array(SecretItemSchema).max(200).default([]),
    deletes: z.array(SecretKeySchema).max(200).default([]),
});
export type PreviewkitConfigAppSecrets = z.infer<typeof PreviewkitConfigAppSecretsSchema>;

export const PreviewkitConfigSecretsSchema = z.array(PreviewkitConfigAppSecretsSchema).max(50);
export type PreviewkitConfigSecrets = z.infer<typeof PreviewkitConfigSecretsSchema>;
