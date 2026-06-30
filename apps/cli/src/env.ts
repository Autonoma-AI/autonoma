import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// Every environment variable the CLI reads. Defined once so it doubles as the
// allowlist the .env loaders use - they only inject these keys from a project's
// .env / the global ~/.autonoma/.env into process.env, never arbitrary keys
// like PATH or NODE_OPTIONS that happen to live in the target project's .env.
const ENV_SCHEMA = {
    // Model id override (OpenRouter-style id, forwarded by the managed proxy).
    OPENROUTER_MODEL: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    SDK_ENDPOINT_URL: z.string().optional(),
    AUTONOMA_SHARED_SECRET: z.string().optional(),
    AUTONOMA_SIGNING_SECRET: z.string().optional(),
    AUTONOMA_API_URL: z.string().optional(),
    AUTONOMA_API_TOKEN: z.string().optional(),
    AUTONOMA_GENERATION_ID: z.string().optional(),
    AUTONOMA_POSTHOG_KEY: z.string().optional(),
    AUTONOMA_POSTHOG_HOST: z.string().optional(),
    AUTONOMA_DISTINCT_ID: z.string().optional(),
    DONT_TRACK: z.string().optional(),
    AUTONOMA_DEBUG: z.string().optional(),
    EDITOR: z.string().optional(),
    VISUAL: z.string().optional(),
} satisfies Record<string, z.ZodTypeAny>;

/** Keys the CLI recognizes; the .env loaders inject only these into process.env. */
export const ENV_KEYS: readonly string[] = Object.keys(ENV_SCHEMA);

/**
 * Single, validated entry point for the CLI's environment (AGENTS.md rule 25).
 *
 * Unlike a server app, the CLI populates process.env at RUNTIME - from the
 * target project's .env and the global ~/.autonoma/.env (see config.ts and
 * core/global-env.ts) - so the env is validated on demand through this accessor
 * rather than snapshotted once at import. Every key is optional; callers supply
 * defaults or error when a required value (e.g. AUTONOMA_API_TOKEN) is missing.
 * This is the only module that reads process.env for configuration.
 */
export function readEnv() {
    return createEnv({
        server: ENV_SCHEMA,
        runtimeEnv: process.env,
        emptyStringAsUndefined: true,
    });
}

export type CliEnv = ReturnType<typeof readEnv>;
