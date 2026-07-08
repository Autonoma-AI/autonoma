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
        // Dedicated port for the Prometheus /metrics endpoint (MetricsServer).
        // Separate from API_PORT so the ingress never exposes metrics; Prometheus
        // scrapes the pod directly via the prometheus.io annotations in
        // deployment/apps/api.yaml.
        METRICS_PORT: z.coerce.number().int().positive().default(9464),
        INTERNAL_DOMAIN: z.string().optional().default("autonoma.app"),
        COOKIE_DOMAIN: z.string().optional(),
        PREVIEWKIT_ENV: z.stringbool().default(false),
        INVESTIGATION_SHADOW_ENABLED: z.stringbool().default(false),
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
        // Master switch for the managed LLM proxy (planner CLI). Off by default so
        // the route is never mounted unless explicitly enabled - a billing-disabled
        // environment with OPENROUTER_API_KEY set must NOT silently become a free,
        // unmetered LLM gateway. Metering only happens when STRIPE_ENABLED is also on.
        LLM_PROXY_ENABLED: z.stringbool().default(false),
        // Comma-separated allowlist of OpenRouter model ids the managed LLM proxy
        // (planner CLI) may request. Defaults to the single model the planner uses
        // (see LLM_PROXY_DEFAULT_MODELS in llm-proxy-http.router.ts). Set to
        // widen/narrow without a deploy. The proxy is a free, credit-metered gateway,
        // so the allowlist is the primary guard against it being used as a general LLM API.
        LLM_PROXY_ALLOWED_MODELS: z.string().optional(),
        // Abuse cap: the most credits a never-paid org may spend through the
        // managed LLM proxy, out of its free-start grant. A farmed free account
        // can drain at most this much OpenRouter spend via the CLI; purchases
        // raise the budget by the net amount purchased and an active subscription
        // lifts it entirely (see checkLlmProxyGate). Default 20k of the 100k
        // free-start credits.
        LLM_PROXY_FREE_CREDIT_CAP: z.coerce.number().int().nonnegative().default(20_000),
        // Per-request output ceiling. The proxy clamps each request's `max_tokens`
        // to this (and sets it when the caller omits it) so an allowlisted model
        // can't be driven with an unbounded/expensive generation. Keeps any
        // single request's cost - and thus the tiny overspend past the credit cap
        // under concurrency - bounded. Generous by default (above any real
        // single-completion planner output) so it blocks absurd values without
        // truncating legit runs; the credit cap is the real spend bound.
        LLM_PROXY_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(32_768),
        // Per-request input ceiling (bytes of the raw JSON body). Rejects
        // oversized prompts with 413. Generous by default so real large-context
        // planner calls pass; it only blocks absurd payloads.
        LLM_PROXY_MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(4_000_000),
        REDIS_URL: z.string().min(1),

        // Secrets for GitHub HTTP app authentication.
        // Optional when LOCAL_DEV=true (the fake app is used instead); required otherwise.
        // The private key is supplied as base64-encoded PEM and decoded at boot.
        GITHUB_APP_ID: z.string().min(1).optional(),
        GITHUB_APP_PRIVATE_KEY: base64PrivateKey.optional(),
        GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).optional(),
        GITHUB_APP_SLUG: z.string().min(1).optional(),

        // Polite revalidation of the cached PR metadata (FeatureBranchInfo). Throttles the
        // read-triggered revalidate to at most once per app per window, derived from
        // max(prCachedAt) in Postgres. Only open PRs are refreshed (one bulk list call).
        GITHUB_PR_CACHE_REVALIDATE_WINDOW_MINUTES: z.coerce.number().int().positive().default(5),

        // AES-256-GCM key (64 hex chars / 32 bytes) used to decrypt bypass tokens
        // read from the database before returning them to the browser. Must match BYPASS_TOKEN_KEY in Previewkit.
        PREVIEWKIT_BYPASS_TOKEN_KEY: z.string().min(64).optional(),

        // Enables preview environments: pull_request webhooks and the
        // /v1/previewkit lifecycle routes launch the preview deploy/teardown
        // Kubernetes Jobs (apps/previewkit/src/runner). Leave off for dev /
        // self-host without preview infrastructure - webhooks silently skip and
        // the lifecycle routes return 503.
        PREVIEWKIT_ENABLED: z.stringbool().default(false),
        // The API's own Kubernetes namespace (production / beta / alpha). The
        // previewkit launcher reads the per-env `previewkit-runner-image` ConfigMap
        // from here to pin the runner image, then creates the runner Job in the
        // shared `previewkit` namespace. Required when PREVIEWKIT_ENABLED is on.
        NAMESPACE: z.string().min(1).optional(),
        // Shared secret for incoming service-to-service calls: authenticates the
        // native /v1/previewkit/* routes (requireApiKeyOrService) and
        // /v1/diffs/internal/trigger (Authorization: Bearer <secret>).
        PREVIEWKIT_SERVICE_SECRET: z.string().min(1).optional(),
        // VPC-internal Grafana Loki backing the previewkit log streams
        // (GET .../logs/stream, both ?source=build and ?source=app). Build
        // logs are pushed by the previewkit worker (its LOKI_URL); app
        // stdout/stderr is shipped by the Alloy DaemonSet on the preview
        // cluster. Unset disables log streaming (the route returns 503).
        PREVIEWKIT_LOKI_URL: z.url().optional(),

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
