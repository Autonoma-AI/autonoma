import { logger as rootLogger } from "@autonoma/logger";
import { isPreviewUrl } from "@autonoma/types";
import type { Context } from "hono";
import { env } from "../../env";

const logger = rootLogger.child({ name: "previewFrontDoor" });

/** SPA route that authenticates the visitor, waits out the cold start, and bounces to the preview. */
const WAITING_ROUTE = "/preview-waiting";

/**
 * The front door every Autonoma-emitted preview link points at, served at
 * `GET /v1/previewkit/open?to=<preview url>`. It lives on the previewkit prefix
 * rather than a sibling `/v1/preview` mount: two route prefixes one letter apart
 * read as a typo of each other, whatever the router does with them.
 *
 * Previews scale to zero, and the proxy in front of them HOLDS a request to a
 * sleeping environment - sending no bytes at all - until every workload is ready
 * (p50 ~50s, up to 5 minutes). A browser shows a blank tab for that whole time,
 * which reads as broken. This route exists so a human gets a page that explains
 * itself instead, while every non-browser caller keeps today's exact behavior.
 *
 * The fork is safe HERE and would not be safe in the proxy. This route is GET-only
 * and side-effect-free, so misclassifying a client can only produce the wrong
 * *representation*: a machine that receives HTML fails loudly and immediately, and
 * a browser that receives the 307 simply lands on the preview and sees today's
 * behavior. In the proxy the same mistake would silently rewrite a scenario `up`
 * POST into a GET (fetch follows redirects by default and 302/303 drops the body),
 * surfacing as a schema error that blames the customer's recipe.
 *
 * The 307 is a recovery path, not the mechanism: preview PR comments also carry the
 * raw URLs in a machine-readable block, so an agent should never need this branch.
 */
export function previewFrontDoor(c: Context): Response {
    const to = c.req.query("to");

    if (to == null || !isPreviewUrl(to, env.INTERNAL_DOMAIN)) {
        logger.warn("Preview front door called with a disallowed target", { extra: { to } });
        return c.text("Missing or invalid `to` - it must be a preview URL.", 400);
    }

    if (!isBrowserNavigation(c.req.header("sec-fetch-mode"), c.req.header("accept"))) {
        // A programmatic caller wants the app, not a waiting room. 307 rather than
        // 302 so the method and body survive for anything that is not a GET.
        return c.redirect(to, 307);
    }

    return c.redirect(`${env.APP_URL}${WAITING_ROUTE}?to=${encodeURIComponent(to)}`, 302);
}

/**
 * Whether this request is a browser opening a page, as opposed to curl, an HTTP
 * library, or an MCP agent. `Sec-Fetch-Mode: navigate` is sent by every current
 * browser on a top-level navigation and by nothing else; the `Accept` check is the
 * fallback for the handful of older browsers that predate Fetch Metadata.
 *
 * Erring toward "not a browser" is the safe direction - that branch returns the
 * same redirect a machine wants, and a browser following it still reaches the app.
 */
function isBrowserNavigation(secFetchMode: string | undefined, accept: string | undefined): boolean {
    if (secFetchMode != null) return secFetchMode === "navigate";
    return accept != null && accept.includes("text/html");
}
