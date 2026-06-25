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

const PREVIEWKIT_BUILTIN_ENV_KEYS: ReadonlySet<string> = new Set(
    PREVIEWKIT_BUILTIN_ENV_VARS.map((variable) => variable.key),
);

/** True when `key` is one of the reserved Previewkit built-in env var names. */
export function isReservedPreviewkitEnvKey(key: string): boolean {
    return PREVIEWKIT_BUILTIN_ENV_KEYS.has(key);
}
