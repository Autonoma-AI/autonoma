import { z } from "zod";
import { SecretItemSchema, type SecretItem } from "./secrets";

// Same regex used by `.preview.yaml` for addon names — the org-secret name is
// what the `auth_secret:` field references, so they share a namespace and a
// shape (lowercase alphanumeric with hyphens, Kubernetes-label friendly).
const ORG_SECRET_NAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export const OrgSecretNameSchema = z
    .string()
    .min(2)
    .max(63)
    .regex(
        ORG_SECRET_NAME_REGEX,
        "Org secret name must be lowercase alphanumeric with hyphens (matches the `.preview.yaml` auth_secret field)",
    );

export const ListOrgSecretsInputSchema = z.object({
    name: OrgSecretNameSchema,
});
export type ListOrgSecretsInput = z.infer<typeof ListOrgSecretsInputSchema>;

export const UpsertOrgSecretInputSchema = z.object({
    name: OrgSecretNameSchema,
    // Same item shape as per-app secrets: { key, value } where the AWS SM
    // SecretString stores them as a flat JSON map. Providers pick the keys
    // they care about (NeonProvider expects `token`).
    items: z.array(SecretItemSchema).min(1).max(50),
});
export type UpsertOrgSecretInput = z.infer<typeof UpsertOrgSecretInputSchema>;

export const DeleteOrgSecretKeyInputSchema = z.object({
    name: OrgSecretNameSchema,
    key: z.string().min(1),
});
export type DeleteOrgSecretKeyInput = z.infer<typeof DeleteOrgSecretKeyInputSchema>;

export type OrgSecretItem = SecretItem;
