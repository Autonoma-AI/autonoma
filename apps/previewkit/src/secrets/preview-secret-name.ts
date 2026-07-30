/** 63 is the K8s label/name limit; the suffix takes 8 of it. */
const MAX_APP_NAME_LENGTH = 55;

/**
 * The K8s Secret an app's runtime secrets are materialized into, derived from the
 * inner app's name. The per-PR namespace already provides isolation, so
 * `<appName>-secrets` is unique without further scoping. Mirrors the rules every
 * `previewkit.dev/managed-by` k8s name follows: lowercase alnum + hyphens,
 * trimmed, capped under the 63-char label limit.
 *
 * Lossy and many-to-one on purpose (the DB's uniqueness key is the raw appName),
 * which is why `dedupeSecretRecordsByTarget` exists.
 */
export function previewSecretName(appName: string): string {
    return appName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, MAX_APP_NAME_LENGTH)
        .concat("-secrets");
}
