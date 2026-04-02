import { analytics } from "@autonoma/analytics";
import { logger } from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { applicationSetupHttpRouter } from "./application-setup/application-setup-http.router";
import { auth, createContext, storageProvider } from "./context";
import { isAllowedOrigin } from "./cors-origin-matcher";
import { env } from "./env";
import { githubHttpRouter } from "./github/github-http.router";
import { appRouter } from "./routes/router";
import { shouldLogRequestBody } from "./should-log-request-body";
import { stripeHttpRouter } from "./stripe/stripe-http.router";

const ALLOWED_ORIGINS = env.ALLOWED_ORIGINS;

const corsOptions = {
    origin: (origin: string) => {
        if (isAllowedOrigin(origin, ALLOWED_ORIGINS)) return origin;
        return null;
    },
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
};

export function createApiApp() {
    const app = new Hono();

    app.use("*", async (c, next) =>
        Sentry.withScope(async (scope) => {
            scope.setTag("method", c.req.method);
            scope.setTag("url", c.req.url);
            scope.setTag("request_id", crypto.randomUUID());

            if (c.req.path === "/health") return await next();

            const start = Date.now();
            const { method, url } = c.req;
            const queryParams = c.req.queries();

            let body: unknown;
            const contentType = c.req.header("content-type") ?? "";
            if (shouldLogRequestBody({ method, path: c.req.path, contentType })) {
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

    // ─── Application Setup (Claude plugin API) ────────────────────────

    app.route("/v1/setup", applicationSetupHttpRouter);

    // ─── GitHub ───────────────────────────────────────────────────────

    app.route("/v1/github", githubHttpRouter);

    // ─── Stripe ───────────────────────────────────────────────────────

    if (env.STRIPE_ENABLED) {
        app.route("/v1/stripe", stripeHttpRouter);
    } else {
        logger.info("Stripe routes disabled (STRIPE_ENABLED=false)");
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
