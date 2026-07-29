import { logger as rootLogger } from "@autonoma/logger";
import type { Context } from "hono";
import { env } from "../../env";
import { resolveFrontDoorRedirect } from "./preview-front-door-decision";

const logger = rootLogger.child({ name: "previewFrontDoor" });

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
 *
 * The decision itself lives in `preview-front-door-decision.ts` (env-free, unit-
 * tested); this handler just reads `env` and turns the decision into a `Response`.
 */
export function previewFrontDoor(c: Context): Response {
    const decision = resolveFrontDoorRedirect({
        to: c.req.query("to"),
        secFetchMode: c.req.header("sec-fetch-mode"),
        accept: c.req.header("accept"),
        appUrl: env.APP_URL,
        internalDomain: env.INTERNAL_DOMAIN,
    });

    if (decision.kind === "invalid") {
        logger.warn("Preview front door called with a disallowed target", { extra: { to: c.req.query("to") } });
        return c.text("Missing or invalid `to` - it must be a preview URL.", 400);
    }
    // 307 (not 302) for a machine so the method and body survive if it ever isn't a GET.
    return c.redirect(decision.location, decision.kind === "passthrough" ? 307 : 302);
}
