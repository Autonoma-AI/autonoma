import { logger as rootLogger } from "@autonoma/logger";
import { Hono } from "hono";
import { env } from "../env";

const POSTHOG_HOST = env.POSTHOG_HOST;
const POSTHOG_ASSETS_HOST = POSTHOG_HOST.replace("us.i.posthog.com", "us-assets.i.posthog.com");

const logger = rootLogger.child({ name: "PostHogProxy" });

const HOP_BY_HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
]);

function buildProxyHeaders(incoming: Headers): Headers {
    const outgoing = new Headers();
    for (const [key, value] of incoming.entries()) {
        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase()) || key.toLowerCase() === "host") continue;
        outgoing.set(key, value);
    }
    return outgoing;
}

// mountPath is whatever this router is mounted at via `app.route(mountPath, ...)` (e.g. "/rs",
// "/flags") - it must be stripped from the incoming path before forwarding upstream. Kept as a
// parameter rather than hardcoded so the mount point can be renamed without touching this file,
// since ad blockers target well-known PostHog proxy path names and force periodic renames.
export function createPostHogProxyRouter(mountPath: string): Hono {
    const router = new Hono();

    router.all("/static/*", async (c) => {
        const path = c.req.path.replace(`${mountPath}/static/`, "/static/");
        const targetUrl = `${POSTHOG_ASSETS_HOST}${path}`;

        logger.debug("Proxying PostHog asset request", { path, targetUrl });

        const response = await fetch(targetUrl, {
            method: c.req.method,
            headers: buildProxyHeaders(c.req.raw.headers),
        });

        return new Response(response.body, {
            status: response.status,
            headers: {
                "content-type": response.headers.get("content-type") ?? "application/octet-stream",
            },
        });
    });

    router.all("/*", async (c) => {
        const path = c.req.path.replace(mountPath, "");
        const search = new URL(c.req.url).search;
        const targetUrl = `${POSTHOG_HOST}${path}${search}`;

        logger.debug("Proxying PostHog request", { path, targetUrl });

        const hasBody = !["GET", "HEAD"].includes(c.req.method);
        const body = hasBody ? await c.req.arrayBuffer() : undefined;

        const response = await fetch(targetUrl, {
            method: c.req.method,
            headers: buildProxyHeaders(c.req.raw.headers),
            body,
        });

        return new Response(response.body, {
            status: response.status,
            headers: {
                "content-type": response.headers.get("content-type") ?? "application/json",
            },
        });
    });

    return router;
}
