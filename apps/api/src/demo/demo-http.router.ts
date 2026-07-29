import { db } from "@autonoma/db";
import { TooManyRequestsError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import type { Context } from "hono";
import { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import { auth } from "../context";
import { env } from "../env";
import { RateLimiterService } from "../rate-limit/rate-limiter.service";
import { setSessionActiveOrg } from "../routes/auth/set-session-active-org";

const logger = rootLogger.child({ name: "DemoRouter" });

/**
 * The single shared identity every demo visitor authenticates as - like one account
 * opened in many browsers at once. Each visitor still gets their own session token
 * (see the mint below), so concurrent visitors never collide; they only share the
 * user row and the frozen, read-only demo data.
 *
 * The email is on a reserved-unregistrable `.invalid` domain (RFC 2606) so it can
 * never receive mail and can never collide with a real signup, and is deliberately
 * NOT on INTERNAL_DOMAIN - that would grant this account admin/internal treatment.
 */
const DEMO_USER_EMAIL = "demo-viewer@northwind-bank.invalid";
const DEMO_USER_NAME = "Demo";

/**
 * Each entry mints a session (auth hooks + a Redis write), so cap how fast one client
 * can spin them up: generous enough that normal navigation never trips it (one click =
 * one mint), tight enough to blunt a mint-flood against an unauthenticated endpoint.
 */
const DEMO_ENTRY_RATE_LIMIT = { max: 30, windowMs: 60_000 };

const rateLimiter = new RateLimiterService(db);

export const demoHttpRouter = new Hono();

/**
 * GET /v1/demo - the public "See the demo" entry. Mints a fresh read-only session for
 * the shared demo user pointed at DEMO_ORG, sets the session cookie, and redirects into
 * the product. No login or signup: anyone who clicks the landing CTA lands inside the
 * demo, able to navigate but not mutate (every mutation is blocked by `writeProcedure`
 * while DEMO_ORG is the active org). A top-level browser navigation, not a fetch, so no
 * CORS - the redirect response carries the Set-Cookie for the `.INTERNAL_DOMAIN` parent,
 * which better-auth's crossSubDomainCookies then sends to both the app and API hosts.
 */
demoHttpRouter.get("/", async (c) => {
    const demoOrgId = env.DEMO_ORG;
    if (demoOrgId == null) {
        // The route is only mounted when DEMO_ORG is set; guard anyway.
        logger.warn("Demo entry hit with no DEMO_ORG configured");
        return c.redirect(env.APP_URL);
    }

    const clientIp = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    try {
        await rateLimiter.consume(`demo-entry:${clientIp}`, DEMO_ENTRY_RATE_LIMIT);
    } catch (err) {
        if (err instanceof TooManyRequestsError) {
            logger.warn("Demo entry rate limited", { extra: { clientIp } });
            return c.text("Too many demo sessions from here - please try again in a minute.", 429);
        }
        throw err;
    }

    const org = await db.organization.findUnique({ where: { id: demoOrgId }, select: { id: true } });
    if (org == null) {
        logger.error("DEMO_ORG points at a non-existent organization", { organizationId: demoOrgId });
        return c.redirect(env.APP_URL);
    }

    const demoUserId = await ensureDemoUser(demoOrgId);
    const sessionToken = await mintDemoSession(demoUserId, demoOrgId);
    await setDemoSessionCookie(c, sessionToken);

    logger.info("Demo session minted", { userId: demoUserId, organizationId: demoOrgId });
    return c.redirect(env.APP_URL);
});

/**
 * Idempotently ensures the shared demo user exists and is a `member` of DEMO_ORG.
 * Membership is what makes `orgStatus` resolve to "approved" (so the viewer lands in
 * the app, not a pending screen) and what makes the session-create hook pick DEMO_ORG
 * as the active org. One row for one fixed user - not one per visitor.
 */
async function ensureDemoUser(demoOrgId: string): Promise<string> {
    const user = await db.user.upsert({
        where: { email: DEMO_USER_EMAIL },
        update: {},
        create: { name: DEMO_USER_NAME, email: DEMO_USER_EMAIL, emailVerified: true },
        select: { id: true },
    });

    await db.member.upsert({
        where: { userId_organizationId: { userId: user.id, organizationId: demoOrgId } },
        update: {},
        create: { userId: user.id, organizationId: demoOrgId, role: "member" },
    });

    return user.id;
}

async function mintDemoSession(userId: string, demoOrgId: string): Promise<string> {
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession(userId);
    // The session-create hook already resolves the active org from the demo user's sole
    // membership, but pin DEMO_ORG explicitly so a stray membership can never land a
    // visitor in the wrong org.
    await setSessionActiveOrg(auth, session.token, demoOrgId);
    return session.token;
}

/** Sets better-auth's signed session cookie, matching how the Vercel SSO flow does it. */
async function setDemoSessionCookie(c: Context, token: string): Promise<void> {
    const ctx = await auth.$context;
    const { name, attributes } = ctx.authCookies.sessionToken;
    await setSignedCookie(c, name, token, ctx.secret, {
        httpOnly: true,
        sameSite: "Lax",
        secure: attributes.secure,
        path: "/",
        domain: attributes.domain ?? undefined,
    });
}
