import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * The eval harness's own environment, separate from the CLI product's `env.ts`.
 * Every key is optional so `--help`/dry paths don't require credentials; the call
 * sites that actually need a value (the checkout, the drive) throw a clear error
 * when it is missing. Judge model calls go through the CLI's `getModel`, which
 * reads `AUTONOMA_API_TOKEN` from the CLI env - keep that set too when judging.
 */
const ENV_SCHEMA = {
    /** GitHub App id. Defaults to DEFAULT_GITHUB_APP_ID (a non-secret identifier); override to test another app. */
    GITHUB_APP_ID: z.string().optional(),
    /** GitHub App private key as a raw PEM. Note: a multiline PEM does NOT survive `--env-file`; prefer the _FILE form. */
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    /** Path to the GitHub App private-key PEM file - the robust way to supply it (see GITHUB_APP_PRIVATE_KEY). */
    GITHUB_APP_PRIVATE_KEY_FILE: z.string().optional(),
    /** Bedrock bearer token for the driven `claude -p` subinstance. Refresh before a run if it has expired. */
    AWS_BEARER_TOKEN_BEDROCK: z.string().optional(),
    /** Bedrock region for the driven subinstance. */
    AWS_REGION: z.string().optional(),
    /** OpenRouter API key for the judge - it calls OpenRouter DIRECTLY, not the customer credit proxy. */
    OPENROUTER_API_KEY: z.string().optional(),
    /** Model id for the driven subinstance (Bedrock model id). */
    SDK_INTEGRATION_MODEL: z.string().optional(),
    /** Model id for the judge (OpenRouter-style id, forwarded by the CLI proxy). */
    JUDGE_MODEL: z.string().optional(),
    /**
     * Path to an operator-provided env/secrets file (uncommitted, e.g. under `/tmp`) holding the
     * real external-service credentials the driven agent needs to boot a case's app - ones that
     * genuinely can't be discovered or mocked (e.g. a hosted auth provider's key). Its directory
     * is exposed to the agent via `--add-dir` and the drive prompt points the agent at the file.
     * Never commit the file; keep it outside the repo.
     */
    SDK_EVAL_SECRETS_FILE: z.string().optional(),
} satisfies Record<string, z.ZodTypeAny>;

export function readHarnessEnv() {
    return createEnv({
        server: ENV_SCHEMA,
        runtimeEnv: process.env,
        emptyStringAsUndefined: true,
    });
}

export type HarnessEnv = ReturnType<typeof readHarnessEnv>;

/** Default Bedrock region when `AWS_REGION` is unset. */
export const DEFAULT_AWS_REGION = "us-east-1";

/**
 * The Autonoma GitHub App id (installed on client orgs to fetch their repos). This
 * is a non-secret identifier - the app is public at github.com/apps/autonoma-ai -
 * so it ships as a default; only the private key is a real secret. Override with
 * GITHUB_APP_ID to point at a different app.
 */
export const DEFAULT_GITHUB_APP_ID = "2968304";
