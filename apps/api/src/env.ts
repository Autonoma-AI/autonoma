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
        // Domain-ownership token OpenAI's Apps directory checks for at
        // /.well-known/openai-apps-challenge before accepting an MCP server
        // registration on this domain. Set per submission; harmless to leave
        // in place afterward.
        OPENAI_APPS_CHALLENGE_TOKEN: z.string().optional(),
        // Branch name a new application's deploy ref is seeded with, before a repo
        // is linked and its real default branch is known. It is overwritten with the
        // repo's actual default branch the moment a repo is linked, so this is only
        // a last-resort fallback for the brief unlinked window - never an assumption
        // that a repo's default branch is "main".
        FALLBACK_DEFAULT_BRANCH: z.string().default("main"),
        COOKIE_DOMAIN: z.string().optional(),
        PREVIEWKIT_ENV: z.stringbool().default(false),
        // Comma-separated allowlist of emails permitted to use password sign-in/sign-up
        // in production (e.g. a marketplace-reviewer test account). Every other account
        // is Google SSO only - see the emailAndPassword hooks in auth.ts.
        TEST_ACCOUNT_ALLOWED_EMAILS: z.string().optional(),
        INVESTIGATION_SHADOW_ENABLED: z.stringbool().default(false),
        // Global master kill-switch for the merged analysis pipeline. Off by default: while off, no org runs the
        // merged pipeline no matter its per-org `analysisEnabled` setting - the trigger falls back to diffs. Only
        // when this is on does an org whose setting is enabled run analysis (which promotes its snapshot and files
        // real bugs, replacing diffs for the org). Two gates (this env switch + the per-org setting) so a flip is
        // deliberate, per-org, and instantly reversible for the whole fleet.
        ANALYSIS_AUTHORITATIVE_ENABLED: z.stringbool().default(false),
        ALLOWED_ORIGINS: z.string().optional().default("http://localhost:3000"),
        // Public origin where this API's own /v1/auth handler is reachable - NOT
        // the UI's origin (APP_URL). They coincide in prod/beta (unified behind
        // one ingress) but diverge in local dev (UI :3000, API :4000) and
        // previewkit (separate UI/API deploys). Falls back to APP_URL when unset.
        BETTER_AUTH_URL: z.string().url().optional(),
        // Public origin advertised as the OAuth `resource` in the MCP
        // protected-resource metadata - the host MCP clients actually connect
        // to for /v1/mcp/*. In prod/beta this is the dedicated `api.<host>`
        // origin (direct to the ALB, off CloudFront), which differs from the
        // OAuth authorization server origin (APP_URL, behind CloudFront). A
        // strict MCP client rejects the handshake unless this matches the host
        // it dialed (see connect-agent-dialog's mcpEndpointUrl). Falls back to
        // AUTH_BASE_URL (BETTER_AUTH_URL ?? APP_URL) when unset - correct for
        // local dev and previewkit, where the MCP endpoint shares the API origin.
        MCP_RESOURCE_URL: z.string().url().optional(),
        SCENARIO_ENCRYPTION_KEY: z.string().min(1),
        GOOGLE_CLIENT_ID: z.string().min(1),
        GOOGLE_CLIENT_SECRET: z.string().min(1),

        // Vercel marketplace integration credentials.
        // Optional in test/dev environments; required in production for the
        // integration to function. The Vercel routes are mounted regardless,
        // but return 503 / throw clear errors when these are unset.
        VERCEL_CLIENT_ID: z.string().min(1).optional(),
        VERCEL_CLIENT_SECRET: z.string().min(1).optional(),
        VERCEL_REDIRECT_URI: z.string().url().optional(),
        VERCEL_ENCRYPTION_KEY: z.string().length(64).optional(),
        // Full URL users are sent to in order to install / connect the Autonoma
        // Vercel integration (e.g. https://vercel.com/integrations/{slug}/new, or a
        // specific marketplace listing URL). Surfaced to the UI as the "Connect Vercel"
        // target; when unset the connect step shows an explanatory message instead.
        VERCEL_INTEGRATION_URL: z.string().url().optional(),
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
        // oversized prompts with 413. Sized to comfortably hold a request that
        // fills the planner model's full ~1M-token context window (which the CLI
        // legitimately builds) plus JSON/UTF-8 overhead - roughly 4x the raw-text
        // size of a full window - so real runs always pass and only a payload
        // several times the model's own limit is rejected. The credit cap
        // (LLM_PROXY_FREE_CREDIT_CAP) is the real abuse bound; this only keeps a
        // single request from buffering unbounded memory.
        LLM_PROXY_MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(16_000_000),
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
