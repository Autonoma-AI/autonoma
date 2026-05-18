import { z } from "zod";

const SECRET_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Mirrors the k8sNameRegex in apps/previewkit/src/config/schema.ts. Secret
// bundles are scoped to the same app names that appear in `.preview.yaml`.
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
    key: SecretKeySchema,
    value: z.string().min(1).max(65536),
});
export type SecretItem = z.infer<typeof SecretItemSchema>;

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
