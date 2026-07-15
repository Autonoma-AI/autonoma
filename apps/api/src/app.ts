import { analytics } from "@autonoma/analytics";
import { logger } from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { applicationSetupHttpRouter } from "./application-setup/application-setup-http.router";
import { auth, createContext, storageProvider } from "./context";
import { diffsHttpRouter } from "./diffs/diffs-http.router";
import { env } from "./env";
import { githubHttpRouter } from "./github/github-http.router";
import { llmProxyHttpRouter } from "./llm-proxy/llm-proxy-http.router";
import { mcpHttpRouter } from "./mcp/mcp-http.router";
import { posthogProxyRouter } from "./posthog/posthog-proxy.router";
import { previewkitHttpRouter } from "./previewkit/previewkit-http.router";
import { onboardingHttpRouter } from "./routes/onboarding/onboarding-http.router";
import { appRouter } from "./routes/router";
import { stripeHttpRouter } from "./stripe/stripe-http.router";
import { vercelInstallationsRouter, vercelProductsRouter } from "./vercel-marketplace/vercel-installations.router";
import { vercelMarketplaceRouter } from "./vercel-marketplace/vercel-marketplace.router";
import { vercelWebhooksRouter } from "./vercel-marketplace/vercel-webhooks.router";

const ALLOWED_ORIGINS = env.ALLOWED_ORIGINS;
const BODY_LOG_BLOCKLIST_PATHS = new Set(["/v1/stripe/webhook", "/v1/vercel/webhooks"]);
// Prefixes whose request bodies must never be logged. Unlike the exact-match set
// above, these cover routes with dynamic path segments - secret values flow
// through PUT /v1/previewkit/secrets/:applicationId/:app[/:key], and through
// PUT /v1/installations/:installationId (Vercel's `credentials.access_token`).
const BODY_LOG_BLOCKLIST_PREFIXES = ["/v1/previewkit/secrets", "/v1/installations"];

const INTERNAL_DOMAIN_ESCAPED = env.INTERNAL_DOMAIN.replace(/\./g, "\\.");
const PREVIEW_ORIGIN_PATTERN = new RegExp(`^https://[a-f0-9]+\\.preview\\.${INTERNAL_DOMAIN_ESCAPED}$`);

const corsOptions = {
    origin: (origin: string) => {
        if (ALLOWED_ORIGINS.includes(origin)) return origin;
        if (/^https:\/\/alpha-[a-f0-9]+\.alpha\.agent\.autonoma\.app$/.test(origin)) return origin;
        // New alpha scheme (hash-only host <hash>.alpha.autonoma.app); migrating off the .alpha.agent.* hosts.
        if (/^https:\/\/[a-f0-9]+\.alpha\.autonoma\.app$/.test(origin)) return origin;
        if (/^https:\/\/alpha-[a-f0-9]+\.agent\.autonoma\.app$/.test(origin)) return origin;
        if (PREVIEW_ORIGIN_PATTERN.test(origin)) return origin;
        return null;
    },
    credentials: true,
    // `Last-Event-ID` is sent by the SSE client (fetch-event-source) on reconnect.
    allowHeaders: ["Content-Type", "Authorization", "Last-Event-ID"],
};

export function createApiApp() {
    const app = new Hono();

    app.use("*", async (c, next) =>
        Sentry.withScope(async (scope) => {
            scope.setTag("method", c.req.method);
            scope.setTag("url", c.req.url);
            scope.setTag("request_id", crypto.randomUUID());

            if (c.req.path === "/health" || c.req.path.startsWith("/ingest")) return await next();

            const start = Date.now();
            const { method, url } = c.req;
            const queryParams = c.req.queries();

            let body: unknown;
            const contentType = c.req.header("content-type") ?? "";
            const isBlocklistedBodyPath =
                BODY_LOG_BLOCKLIST_PATHS.has(c.req.path) ||
                BODY_LOG_BLOCKLIST_PREFIXES.some((prefix) => c.req.path.startsWith(prefix));
            const shouldLogBody =
                ["POST", "PUT", "PATCH"].includes(method) &&
                !contentType.startsWith("multipart/form-data") &&
                !isBlocklistedBodyPath;

            if (shouldLogBody) {
                try {
                    const cloned = c.req.raw.clone();
                    body = await cloned.json();
                } catch {
                    body = null;
                }
            }

            logger.info(`→ ${method} ${url}`, {
                ...(Object.keys(queryParams).length && { queryParams }),
                ...(body != null && { body }),
            });

            await next();

            logger.info(`← ${method} ${url} ${c.res.status} (${Date.now() - start}ms)`, {
                status: c.res.status,
                duration: Date.now() - start,
            });
        }),
    );

    app.use("/v1/auth/*", cors(corsOptions));

    app.on(["POST", "GET"], "/v1/auth/**", (c) => auth.handler(c.req.raw));

    // MCP clients discover the authorization server from these well-known
    // endpoints (Better Auth's `mcp()` plugin serves the metadata). CORS is
    // enabled so browser-based MCP clients (e.g. ChatGPT) can fetch them.
    app.use("/.well-known/oauth-*", cors(corsOptions));
    app.get("/.well-known/oauth-authorization-server", (c) => oAuthDiscoveryMetadata(auth)(c.req.raw));
    app.get("/.well-known/oauth-protected-resource", (c) => oAuthProtectedResourceMetadata(auth)(c.req.raw));

    // ─── Application Setup (Claude plugin API) ────────────────────────

    app.route("/v1/setup", applicationSetupHttpRouter);

    // ─── Diffs ─────────────────────────────────────────────────────

    app.route("/v1/diffs", diffsHttpRouter);

    // ─── GitHub ───────────────────────────────────────────────────────

    app.route("/v1/github", githubHttpRouter);

    // ─── LLM Proxy (planner CLI managed credits) ───────────────────────
    // The CLI points its OpenRouter provider here with its Autonoma API key;
    // the proxy forwards to OpenRouter with our key and meters credits. No CORS
    // mount - the caller is the CLI, not a browser. Mounted only when explicitly
    // enabled AND billing is on: metering depends on billing, so requiring both
    // makes "the proxy is always metered" an invariant and fails closed - a
    // billing-disabled environment can never become a free, unmetered gateway.

    if (env.LLM_PROXY_ENABLED && env.STRIPE_ENABLED) {
        app.route("/v1/llm-proxy", llmProxyHttpRouter);
    } else if (env.LLM_PROXY_ENABLED && !env.STRIPE_ENABLED) {
        logger.error(
            "LLM proxy NOT mounted: LLM_PROXY_ENABLED=true but STRIPE_ENABLED=false. Enable billing so usage can be metered.",
        );
    } else {
        logger.info("LLM proxy routes disabled (LLM_PROXY_ENABLED=false)");
    }

    // ─── Previewkit ────────────────────────────────────────────────────

    // The build-log SSE stream is browser-facing and cross-origin in preview
    // environments (with credentials), so CORS must mirror the tRPC mount.
    app.use("/v1/previewkit/*", cors(corsOptions));
    app.route("/v1/previewkit", previewkitHttpRouter);

    // Namespaced resource servers under /v1/mcp/<name> (today: "debug").
    // CORS so browser-based MCP clients can call the Streamable HTTP endpoint.
    app.use("/v1/mcp/*", cors(corsOptions));
    app.route("/v1/mcp", mcpHttpRouter);

    // ─── Onboarding HTTP integrations ────────────────────────────────

    app.route("/v1/onboarding", onboardingHttpRouter);

    // ─── Stripe ───────────────────────────────────────────────────────

    if (env.STRIPE_ENABLED) {
        app.route("/v1/stripe", stripeHttpRouter);
    } else {
        logger.info("Stripe routes disabled (STRIPE_ENABLED=false)");
    }

    // ─── Vercel Marketplace ─────────────────────────────────────────────
    // Gated on VERCEL_CLIENT_ID (all Vercel env vars are optional together -
    // see env.ts): an unconfigured deployment simply never mounts these
    // routes rather than mounting them to fail at request time.

    if (env.VERCEL_CLIENT_ID != null) {
        app.use("/v1/vercel/*", cors(corsOptions));
        app.route("/v1/vercel", vercelMarketplaceRouter);

        // Server-to-server from Vercel's backend - no CORS, and mounted before
        // the marketplace CORS middleware above only matches "/v1/vercel/*" as a
        // prefix, which this path falls under; Vercel never sends an Origin
        // header on webhook deliveries so the CORS middleware is a no-op here.
        app.route("/v1/vercel/webhooks", vercelWebhooksRouter);

        app.use("/v1/installations/*", cors(corsOptions));
        app.route("/v1/installations", vercelInstallationsRouter);

        app.use("/v1/products/*", cors(corsOptions));
        app.route("/v1/products", vercelProductsRouter);
    } else {
        logger.info("Vercel Marketplace routes disabled (VERCEL_CLIENT_ID not set)");
    }

    // ─── Upload ───────────────────────────────────────────────────────

    app.use("/v1/upload/*", cors(corsOptions));

    app.put("/v1/upload/package", async (c) => {
        const session = await auth.api.getSession({ headers: c.req.raw.headers });

        if (session?.user == null || session.session?.activeOrganizationId == null) {
            return c.json({ error: "Unauthorized" }, 401);
        }

        const organizationId = session.session.activeOrganizationId;
        const filename = c.req.header("x-filename");

        if (filename == null || filename.length === 0) {
            return c.json({ error: "x-filename header is required" }, 400);
        }

        const body = c.req.raw.body;
        if (body == null) {
            return c.json({ error: "Request body is required" }, 400);
        }

        const key = `packages/${organizationId}/${crypto.randomUUID()}/${filename}`;

        logger.info("Streaming package upload", { organizationId, filename, key });

        const url = await storageProvider.uploadStream(key, body);

        logger.info("Package upload complete", { organizationId, key, url });

        return c.json({ url });
    });

    // ─── PostHog Proxy (bypasses ad blockers) ──────────────────────────

    app.use("/ingest/*", cors(corsOptions));
    app.route("/ingest", posthogProxyRouter);

    // ─── tRPC ─────────────────────────────────────────────────────────

    app.use("/v1/trpc/*", cors(corsOptions));

    app.use("/v1/trpc/*", async (ctx) => {
        return await fetchRequestHandler({
            endpoint: "/v1/trpc",
            req: ctx.req.raw,
            router: appRouter,
            createContext: () => createContext(ctx),
        });
    });

    app.get("/health", (c) => c.json({ ok: true }));

    return app;
}

export async function shutdownApi() {
    logger.info("Shutting down...");
    await analytics.shutdown();
}
