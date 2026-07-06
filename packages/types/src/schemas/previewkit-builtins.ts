/**
 * Built-in environment variables Previewkit injects into every preview app pod
 * at deploy time. They let app code detect it is running inside a preview and
 * react to it (e.g. set the Sentry `environment` from the PR, build links
 * against the preview URL).
 *
 * These names are reserved: the secrets API rejects user uploads that use them,
 * and the deployer always overrides any user-set value with the real one. The
 * `example` is illustrative only - the actual values are computed per deploy and
 * `AUTONOMA_PREVIEWKIT_URL` is the deployed app's own public URL.
 *
 * Single source of truth for: the deployer (key names), the secrets schema
 * (reserved-key set), and the secrets UIs (disabled "Built-in" hint rows).
 */
export const PREVIEWKIT_BUILTIN_ENV_VARS = [
    {
        key: "AUTONOMA_PREVIEWKIT",
        description: 'Always "true" inside a Previewkit preview. Use it to detect the environment.',
        example: "true",
    },
    {
        key: "AUTONOMA_PREVIEWKIT_PR",
        description: "The pull request number this preview was built from.",
        example: "123",
    },
    {
        key: "AUTONOMA_PREVIEWKIT_URL",
        description: "The public HTTPS URL of this app in the preview.",
        example: "https://<code>.preview.autonoma.app",
    },
] as const;

export type PreviewkitBuiltinEnvVar = (typeof PREVIEWKIT_BUILTIN_ENV_VARS)[number];

/**
 * Secrets Autonoma provisions and mounts into every app of a PreviewKit-managed
 * preview - distinct from {@link PREVIEWKIT_BUILTIN_ENV_VARS} because they are
 * managed AWS secrets (random, rotatable in Settings -> Secrets) rather than
 * per-deploy computed values. The Environment Factory handler can live in any
 * app, so the same (shared, signing) pair is fanned out to each app's secret
 * bundle. Kept as its own list (separate from the built-ins) so the two carry
 * distinct UI hint rows and rejection messages, but both feed the protected-key
 * set via {@link isProtectedPreviewkitEnvKey}. The `example` is a placeholder -
 * the real values are never surfaced.
 */
export const AUTONOMA_MANAGED_ENV_VARS = [
    {
        key: "AUTONOMA_SHARED_SECRET",
        description:
            "Shared secret Autonoma signs Environment Factory requests with; your /api/autonoma handler verifies the HMAC against it. Managed by Autonoma.",
        example: "(managed secret)",
    },
    {
        key: "AUTONOMA_SIGNING_SECRET",
        description:
            "Private secret your SDK handler uses to sign teardown refs tokens. Managed by Autonoma, rotatable in Settings -> Secrets.",
        example: "(managed secret)",
    },
] as const;

export type AutonomaManagedEnvVar = (typeof AUTONOMA_MANAGED_ENV_VARS)[number];

const PREVIEWKIT_BUILTIN_ENV_KEYS: ReadonlySet<string> = new Set(
    PREVIEWKIT_BUILTIN_ENV_VARS.map((variable) => variable.key),
);

const AUTONOMA_MANAGED_ENV_KEYS: ReadonlySet<string> = new Set(
    AUTONOMA_MANAGED_ENV_VARS.map((variable) => variable.key),
);

/** True when `key` is one of the reserved Previewkit built-in env var names. */
export function isReservedPreviewkitEnvKey(key: string): boolean {
    return PREVIEWKIT_BUILTIN_ENV_KEYS.has(key);
}

/** True when `key` is one of the Autonoma-managed SDK secret names. */
export function isManagedPreviewkitEnvKey(key: string): boolean {
    return AUTONOMA_MANAGED_ENV_KEYS.has(key);
}

/** True when `key` is injected by Previewkit and must never be set by a user. */
export function isProtectedPreviewkitEnvKey(key: string): boolean {
    return isReservedPreviewkitEnvKey(key) || isManagedPreviewkitEnvKey(key);
}
