import { env as billingEnv } from "@autonoma/billing/env";
import { env as dbEnv } from "@autonoma/db/env";
import { base64PrivateKey } from "@autonoma/github/schemas";
import { env as loggerEnv } from "@autonoma/logger/env";
import { env as storageEnv } from "@autonoma/storage/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv, dbEnv, storageEnv, billingEnv],
    server: {
        API_PORT: z.string(),
        INTERNAL_DOMAIN: z.string().optional().default("autonoma.app"),
        COOKIE_DOMAIN: z.string().optional(),
        PREVIEWKIT_ENV: z.stringbool().default(false),
        ALLOWED_ORIGINS: z.string().optional().default("http://localhost:3000"),
        SCENARIO_ENCRYPTION_KEY: z.string().min(1),
        GOOGLE_CLIENT_ID: z.string().min(1),
        GOOGLE_CLIENT_SECRET: z.string().min(1),
        AGENT_VERSION: z.string().optional().default("latest"),
        POSTHOG_KEY: z.string().optional(),
        POSTHOG_HOST: z.string().optional().default("https://us.i.posthog.com"),
        GEMINI_API_KEY: z.string().min(1),
        GROQ_KEY: z.string().min(1).optional(),
        OPENROUTER_API_KEY: z.string().min(1).optional(),
        REDIS_URL: z.string().min(1),

        // Secrets for GitHub HTTP app authentication.
        // Optional when LOCAL_DEV=true (the fake app is used instead); required otherwise.
        // The private key is supplied as base64-encoded PEM and decoded at boot.
        GITHUB_APP_ID: z.string().min(1).optional(),
        GITHUB_APP_PRIVATE_KEY: base64PrivateKey.optional(),
        GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).optional(),
        GITHUB_APP_SLUG: z.string().min(1).optional(),

        // AES-256-GCM key (64 hex chars / 32 bytes) used to decrypt bypass tokens
        // read from the database before returning them to the browser. Must match BYPASS_TOKEN_KEY in Previewkit.
        PREVIEWKIT_BYPASS_TOKEN_KEY: z.string().min(64).optional(),

        // Internal Previewkit service URL. When set, pull_request webhooks are forwarded
        // to Previewkit's REST endpoints. Leave unset to disable preview environments.
        PREVIEWKIT_URL: z.string().url().optional(),
        // Shared secret for service-to-service calls between this API and Previewkit.
        // Used both ways:
        //   - INCOMING: Previewkit calls our /v1/diffs/internal/trigger with this as
        //     Authorization: Bearer <secret>; we compare against this env value.
        //   - OUTGOING: this API calls Previewkit's /v1/* endpoints (webhook forwarder)
        //     and signs requests with this same value. Previewkit verifies it on its end.
        // Both sides must hold the same value.
        PREVIEWKIT_SERVICE_SECRET: z.string().min(1).optional(),

        // Used to indicate that we're running in a test environment.
        // This is only intended to avoid importing certain modules, do not use it for any other purpose.
        TESTING: z.stringbool().default(false),
        // When true, swaps third-party integrations (currently just the GitHub app) for local-dev fakes
        // so the API can boot and serve requests without real credentials.
        LOCAL_DEV: z.stringbool().default(false),
        ENGINE_BILLING_SECRET: z.string().min(1).optional(),

        // AWS Secrets Manager — used by the secrets service to store per-app secrets.
        // AWS_REGION is required when any app has secrets; the SDK also reads it from the environment.
        AWS_REGION: z.string().optional(),

        RESEND_API_KEY: z.string().min(1).optional(),
        RESEND_AUDIENCE_ID: z.string().min(1).optional(),
        RESEND_FROM_EMAIL: z.string().min(1).optional().default("Autonoma <hello@autonoma.app>"),
        CAL_ONBOARDING_LINK: z.string().url().optional(),
        SLACK_BOT_TOKEN: z.string().min(1).optional(),
        DISCORD_INVITE_URL: z.string().url().optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
