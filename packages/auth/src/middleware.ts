import { unauthorizedGuidance } from "@autonoma/agent-guidance";
import type { PrismaClient } from "@autonoma/db";
import type { MiddlewareHandler } from "hono";
import { verifyApiKey } from "./api-key";

/**
 * What's set on the Hono context after `requireApiKey` succeeds. Routes
 * that mount this middleware should type their Hono env with
 * `Hono<{ Variables: UserAuthVariables }>` so `c.var.user` is inferred.
 */
export interface UserAuthVariables {
    user: { userId: string; organizationId: string };
}

export interface RequireApiKeyOptions {
    db: PrismaClient;
    /**
     * Canonical app origin, so the 401 body can point at the API-keys screen. Optional because
     * the guidance falls back to the canonical public host; pass it so per-environment deploys
     * (alpha, beta) send the caller to their own settings page rather than production's.
     */
    appUrl?: string;
}

/**
 * Bearer-token middleware. Looks up the token in the `apiKey` table. On
 * success, sets `c.var.user = { userId, organizationId }`; on any failure
 * (missing header, unknown key, expired, disabled) returns 401 with a body
 * explaining how to authenticate, so a headless caller can act on it.
 *
 * Every authenticated caller carries an organization, so routes scope unconditionally.
 */
export function requireApiKey(options: RequireApiKeyOptions): MiddlewareHandler<{ Variables: UserAuthVariables }> {
    return async (c, next) => {
        const ctx = await verifyApiKey(options.db, c.req.header("authorization"));
        // A bare "Unauthorized" tells a headless caller nothing about how to become authorized.
        if (ctx == null) return c.json(unauthorizedGuidance({ appUrl: options.appUrl, surface: "api" }), 401);
        c.set("user", { userId: ctx.userId, organizationId: ctx.organizationId });
        return next();
    };
}
