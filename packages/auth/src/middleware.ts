import type { PrismaClient } from "@autonoma/db";
import type { MiddlewareHandler } from "hono";
import { verifyApiKey } from "./api-key";
import { verifyServiceSecret } from "./service-secret";

/**
 * What's set on the Hono context after `requireApiKey` succeeds. Routes
 * that mount this middleware should type their Hono env with
 * `Hono<{ Variables: UserAuthVariables }>` so `c.var.user` is inferred.
 */
export interface UserAuthVariables {
    user: { userId: string; organizationId: string };
}

/**
 * Discriminated identity set by `requireApiKeyOrService`.
 *   - "service": the caller authenticated with the shared secret. No org
 *     context - the route handler must establish org scoping from the
 *     request body / path.
 *   - "user":    the caller authenticated with an API key tied to a user
 *     within an organization.
 */
export type AuthCaller = { kind: "service" } | { kind: "user"; userId: string; organizationId: string };

export interface CallerAuthVariables {
    authCaller: AuthCaller;
}

export interface RequireApiKeyOptions {
    db: PrismaClient;
}

/**
 * Bearer-token middleware. Looks up the token in the `apiKey` table. On
 * success, sets `c.var.user = { userId, organizationId }`; on any failure
 * (missing header, unknown key, expired, disabled) returns 401 with a
 * `{ error: "Unauthorized" }` JSON body.
 *
 * Use this for routes that only allow human API keys. For routes that
 * also accept the autonoma-to-previewkit service secret, see
 * `requireApiKeyOrService`.
 */
export function requireApiKey(options: RequireApiKeyOptions): MiddlewareHandler<{ Variables: UserAuthVariables }> {
    return async (c, next) => {
        const ctx = await verifyApiKey(options.db, c.req.header("authorization"));
        if (ctx == null) return c.json({ error: "Unauthorized" }, 401);
        c.set("user", { userId: ctx.userId, organizationId: ctx.organizationId });
        return next();
    };
}

export interface RequireServiceSecretOptions {
    /** When `undefined`, the middleware unconditionally 401s. Lets callers
     *  pass an optional env value through without a separate null check. */
    secret: string | undefined;
}

/**
 * Service-secret-only middleware. For service-to-service endpoints with
 * no human user behind the call (e.g. autonoma's internal triggers). No
 * context variables are written - the route handler reads everything it
 * needs from the request body.
 */
export function requireServiceSecret(options: RequireServiceSecretOptions): MiddlewareHandler {
    return async (c, next) => {
        if (!verifyServiceSecret(c.req.header("authorization"), options.secret)) {
            return c.json({ error: "Unauthorized" }, 401);
        }
        return next();
    };
}

export interface RequireApiKeyOrServiceOptions {
    db: PrismaClient;
    /** Optional. When unset, the service-secret path is disabled and only
     *  API-key callers will succeed. */
    serviceSecret: string | undefined;
}

/**
 * Bearer middleware that accepts either path:
 *   1. The shared service secret (constant-time compared).
 *   2. An API key in the `apiKey` table.
 *
 * On success, sets `c.var.authCaller` to the discriminated `AuthCaller`.
 * Routes branch on `c.var.authCaller.kind` to decide whether to apply
 * org scoping (user callers) or trust the request body (service callers).
 */
export function requireApiKeyOrService(
    options: RequireApiKeyOrServiceOptions,
): MiddlewareHandler<{ Variables: CallerAuthVariables }> {
    return async (c, next) => {
        const authorization = c.req.header("authorization");

        if (verifyServiceSecret(authorization, options.serviceSecret)) {
            c.set("authCaller", { kind: "service" });
            return next();
        }

        const ctx = await verifyApiKey(options.db, authorization);
        if (ctx != null) {
            c.set("authCaller", { kind: "user", userId: ctx.userId, organizationId: ctx.organizationId });
            return next();
        }

        return c.json({ error: "Unauthorized" }, 401);
    };
}
