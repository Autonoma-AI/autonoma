import { base64PrivateKey } from "@autonoma/github/schemas";
import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv],
    server: {
        SENTRY_DSN_WORKER_INVESTIGATION: z.string().optional(),
        // GitHub App - to clone the PR's repo at the snapshot's head.
        GITHUB_APP_ID: z.string().min(1),
        GITHUB_APP_PRIVATE_KEY: base64PrivateKey,
        GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
        GITHUB_APP_SLUG: z.string().min(1),
        // The native-OpenAI classifier key (injected into the model session). The OpenRouter/Gemini/Groq
        // keys are read by @autonoma/ai from its own env (smart-visual runs via OpenRouter).
        OPENAI_API_KEY: z.string().min(1),
        INVESTIGATION_CLASSIFIER_MODEL: z.string().default("gpt-5.6-luna"),
        // The selector + classifier + recipe-repair tool-loop step budgets.
        INVESTIGATION_SELECT_MAX_STEPS: z.coerce.number().default(40),
        INVESTIGATION_CLASSIFY_MAX_STEPS: z.coerce.number().default(60),
        INVESTIGATION_REPAIR_MAX_STEPS: z.coerce.number().default(50),
        // The scenario signing-secret encryption key - required only to wire the recipe-repair agent's
        // dry_run_seed tool (it decrypts the app's signing secret to `up` a candidate against the live factory).
        // Optional: when absent the agent still runs, degrading to schema + backend-query checks (no dry-run seed).
        SCENARIO_ENCRYPTION_KEY: z.string().min(1).optional(),
        // Optional Loki base URL for the get_app_logs tool (e.g. http://loki.autonoma.app:3100).
        LOKI_URL: z.string().optional(),
        // Gate for posting investigation results as a PR comment. OFF by default so it never touches real PRs
        // until deliberately enabled (safe rollout).
        INVESTIGATION_PR_COMMENT_ENABLED: z.stringbool().default(false),
        // The CMK wrapping the encryption keys for the database DATABASE_URL points at - the
        // preview-introspection tools read the env a preview runs with out of that database.
        // Unset means those tools cannot answer and say so, rather than reporting an empty
        // environment as a finding.
        PREVIEWKIT_SECRETS_CMK: z.string().min(1).optional(),
        AWS_REGION: z.string().min(1).default("us-east-1"),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
