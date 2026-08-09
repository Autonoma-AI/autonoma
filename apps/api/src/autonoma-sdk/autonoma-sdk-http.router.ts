import { createHmac } from "node:crypto";
import type { AuthContext } from "@autonoma-ai/sdk";
import { createHonoHandler } from "@autonoma-ai/server-hono";
import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { Hono } from "hono";
import { auth } from "../context";
import { env } from "../env";
import { setSessionActiveOrg } from "../routes/auth/set-session-active-org";
import { autonomaFactories } from "./factories";

const logger = rootLogger.child({ name: "AutonomaSdkRouter" });

/**
 * The seeded organization id for this run. The handler runs with
 * `scopeField: "organizationId"`, so `context.scopeValue` is the org id; the
 * created `Organization` ref carries it too. Falls back to `scopeValue` when a
 * ref isn't present, and returns undefined when no org was seeded (auth with a
 * bare user), in which case membership is skipped.
 */
function resolveSeededOrgId(context: AuthContext): string | undefined {
    const fromRefs = context.refs.Organization?.[0]?.id;
    if (typeof fromRefs === "string" && fromRefs.length > 0) return fromRefs;
    if (context.scopeValue.length > 0) return context.scopeValue;
    return undefined;
}

/**
 * The Autonoma SDK test-data endpoint. Signed with HMAC-SHA256 via the SDK
 * handler using AUTONOMA_SHARED_SECRET. Wraps the factories in `factories.ts`
 * and provides an auth callback that returns a real Better Auth session
 * token for the seeded User.
 *
 * Teardown strategy: the beforeDown hook deletes each seeded Organization,
 * which cascades to every tenant-scoped row (Application, Branch, Folder,
 * TestCase, etc.). The per-factory teardowns then clean up the org-less
 * roots (User, Verification, Jwks, OauthApplication, BillingPromoCode).
 * Order is important: cascade first, then per-record teardown for what's
 * left, so we never orphan a User whose org row references it.
 */
export const autonomaSdkHttpRouter = new Hono();

const sharedSecret = env.AUTONOMA_SHARED_SECRET;
const signingSecret = env.AUTONOMA_SIGNING_SECRET;

if (sharedSecret == null || signingSecret == null) {
    // The API must boot in every environment, including the ones that never
    // provision these secrets (prod, most alphas, local dev). Keep the route
    // mounted but inert - only the self-hosted E2E test runner needs it live.
    logger.warn("Autonoma SDK endpoint disabled - AUTONOMA_SHARED_SECRET / AUTONOMA_SIGNING_SECRET not configured");
    autonomaSdkHttpRouter.post("/", (c) => c.json({ error: "Autonoma SDK endpoint not configured" }, 503));
} else {
    logger.info("Autonoma SDK endpoint initialized", {
        extra: {
            // Never log any part of the secret itself - the length is enough to
            // confirm it's configured without leaking key material to Sentry/logs.
            sharedSecretLen: sharedSecret.length,
        },
    });

    autonomaSdkHttpRouter.post(
        "/",
        createHonoHandler({
            scopeField: "organizationId",
            sharedSecret,
            signingSecret,
            factories: autonomaFactories,
            sdk: { language: "typescript", orm: "prisma", server: "hono" },

            beforeDown: async ({ refs }) => {
                const orgs = refs.Organization ?? [];
                const orgIds = orgs.map((org) => org.id).filter((id): id is string => typeof id === "string");
                if (orgIds.length === 0) return;
                logger.info("Cascading teardown by organization", { extra: { organizationIds: orgIds } });
                // Independent per-org cascades - one bulk delete instead of awaiting each in sequence.
                await db.organization.deleteMany({ where: { id: { in: orgIds } } });
            },

            auth: async (user, context) => {
                if (user == null || typeof user.id !== "string") {
                    return { headers: { Authorization: "Bearer autonoma-test-no-user" } };
                }

                const ctx = await auth.$context;

                // Make the seeded user a real member of the seeded org BEFORE minting
                // the session. Autonoma's Better Auth session-create hook resolves a
                // session's active org from the user's FIRST membership (auth.ts
                // ensureOrgMembership); with no `Member` row it auto-creates a fresh
                // EMPTY org and strands the agent on the onboarding wall. `Member` is
                // the app's existing org-membership join table (schema @@map("member")),
                // written the same way on the normal login path (auth.ts:221). Because
                // the row exists before createSession, the hook lands the session in the
                // seeded org and persists activeOrganizationId to both the DB and Redis.
                const organizationId = resolveSeededOrgId(context);
                if (organizationId != null) {
                    await db.member.upsert({
                        where: { userId_organizationId: { userId: user.id, organizationId } },
                        update: {},
                        create: { userId: user.id, organizationId, role: "owner" },
                    });
                } else {
                    logger.warn("No seeded organization in SDK auth context - session will have no active org", {
                        extra: { userId: user.id },
                    });
                }

                // Mint a real Better Auth session row for the seeded User and hand
                // back a session COOKIE the browser is pre-authenticated with. The
                // app signs in via Google OAuth (there is no userId/sessionToken form
                // to type), so we deliberately DO NOT return `credentials` - the engine
                // turns `credentials` into a "log in by typing these" instruction, which
                // strands the agent on the OAuth splash. Cookie-only auth is correct here.
                // Mint the session through Better Auth's OWN adapter - NOT a raw
                // db.session.create. A hand-inserted session row is not one get-session
                // will validate (verified: both raw and signed cookies for such a row
                // return null); internalAdapter.createSession produces the token BA
                // recognises. Mirrors createSession() in vercel-marketplace.router.ts.
                const session = await ctx.internalAdapter.createSession(user.id);

                if (organizationId != null) {
                    await setSessionActiveOrg(auth, session.token, organizationId);
                }

                // Emit exactly what Better Auth reads back (see setSessionCookie in
                // vercel-marketplace.router.ts): its own cookie name, and a Hono-signed
                // value `<token>.<base64(hmac-sha256(token, ctx.secret))>` (mirrors
                // hono/utils/cookie makeSignature) keyed on the Better Auth secret. The
                // cookies travel in the up-response JSON and are injected via Playwright
                // addCookies, so the value is used verbatim (no Set-Cookie re-encoding).
                const { name, attributes } = ctx.authCookies.sessionToken;
                const signature = createHmac("sha256", ctx.secret).update(session.token).digest("base64");
                // Cross-subdomain so the injected cookie authenticates BOTH the UI host
                // (<hash>.alpha…) and the API host (api-<hash>.alpha…). crossSubDomainCookies
                // is prod-only (see auth.ts), so on alpha `attributes.domain` is unset -
                // fall back to the shared parent `.${INTERNAL_DOMAIN}` (e.g. `.autonoma.app`).
                const domain = attributes.domain ?? `.${env.INTERNAL_DOMAIN}`;
                logger.info("Minted test session", {
                    extra: {
                        userId: user.id,
                        sessionId: session.id,
                        organizationId,
                        cookieName: name,
                        cookieDomain: domain,
                    },
                });

                return {
                    cookies: [
                        {
                            name,
                            value: `${session.token}.${signature}`,
                            httpOnly: true,
                            sameSite: "lax",
                            secure: attributes.secure,
                            path: "/",
                            domain,
                        },
                    ],
                    headers: {
                        Authorization: `Bearer ${session.token}`,
                    },
                };
            },
        }),
    );
}
