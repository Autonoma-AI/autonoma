import { analytics } from "@autonoma/analytics";
import { db } from "@autonoma/db";
import { TooManyRequestsError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import type { Context } from "hono";
import { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import { auth, redisClient } from "../context";
import { env } from "../env";
import { RateLimiterService } from "../rate-limit/rate-limiter.service";
import { setSessionActiveOrg } from "../routes/auth/set-session-active-org";
import { ParkedSessionStore } from "./parked-session.store";

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

/**
 * Where the visitor clicked through from, carried as `?source=` by in-app entry points.
 * Anything unrecognised (including the marketing site, which sends nothing) counts as
 * the public landing CTA.
 */
const DEMO_ENTRY_SOURCES: ReadonlySet<string> = new Set(["onboarding"]);
const DEFAULT_DEMO_ENTRY_SOURCE = "public";

const rateLimiter = new RateLimiterService(db);
const parkedSessions = new ParkedSessionStore(redisClient);

export const demoHttpRouter = new Hono();

/**
 * GET /v1/demo - the public "See the demo" entry. Mints a fresh read-only session for
 * the shared demo user pointed at DEMO_ORG, sets the session cookie, and redirects into
 * the product. No login or signup: anyone who clicks the landing CTA lands inside the
 * demo, able to navigate but not mutate (every mutation is blocked by `writeProcedure`
 * while DEMO_ORG is the active org). A top-level browser navigation, not a fetch, so no
 * CORS - the redirect response carries the Set-Cookie for the `.INTERNAL_DOMAIN` parent,
 * which better-auth's crossSubDomainCookies then sends to both the app and API hosts.
 *
 * That is the browser's only session cookie, so a visitor who is already signed in (the
 * in-app "View demo" entry) would be signed out of their own account just by looking at
 * the demo. Their session is parked first, and `/exit` hands it back.
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

    const [demoUserId, currentSession] = await Promise.all([
        ensureDemoUser(demoOrgId),
        auth.api.getSession({ headers: c.req.raw.headers }),
    ]);

    // Already in the demo: re-entering would mint a second demo session and orphan the
    // parked session keyed to the first, stranding the visitor's way back.
    if (currentSession?.user.id === demoUserId) {
        logger.info("Demo entry hit from an existing demo session", { organizationId: demoOrgId });
        return c.redirect(env.APP_URL);
    }

    const sessionToken = await mintDemoSession(demoUserId, demoOrgId);
    const priorSession = resolveParkableSession(currentSession);
    if (priorSession != null) {
        await parkedSessions.park(sessionToken, priorSession.token, priorSession.expiresAt);
    }
    await setSessionCookie(c, sessionToken);

    logger.info("Demo session minted", {
        userId: demoUserId,
        organizationId: demoOrgId,
        extra: { parkedPriorSession: priorSession != null },
    });
    // Attribute the entry to the real visitor when we have one, so an in-app click lands
    // on their profile rather than merging into the shared demo user with every stranger.
    analytics.capture(priorSession?.userId ?? demoUserId, "demo.entered", {
        organizationId: demoOrgId,
        source: resolveEntrySource(c.req.query("source")),
        canReturnToAccount: priorSession != null,
    });
    return c.redirect(env.APP_URL);
});

/**
 * GET /v1/demo/exit - leaves the demo and restores the session the visitor arrived with.
 * Reached from the demo banner's "Back to your account", which only renders when a session
 * is parked. A no-op redirect for anyone who reached the demo without one (the landing-page
 * CTA), so the route is safe to hit at any time.
 */
demoHttpRouter.get("/exit", async (c) => {
    const currentSession = await auth.api.getSession({ headers: c.req.raw.headers });
    if (currentSession == null) {
        logger.info("Demo exit hit with no session");
        return c.redirect(env.APP_URL);
    }

    const priorSessionToken = await parkedSessions.take(currentSession.session.token);
    if (priorSessionToken == null) return c.redirect(env.APP_URL);

    // The parked session can have expired or been revoked (signed out elsewhere) while the
    // visitor was in the demo; send them to log in rather than restoring a dead cookie.
    const priorSession = await db.session.findUnique({
        where: { token: priorSessionToken },
        select: { userId: true, expiresAt: true },
    });
    if (priorSession == null || priorSession.expiresAt <= new Date()) {
        logger.info("Parked session is no longer valid");
        analytics.capture(priorSession?.userId ?? currentSession.user.id, "demo.exited", { outcome: "expired" });
        return c.redirect(`${env.APP_URL}/login`);
    }

    await setSessionCookie(c, priorSessionToken);
    logger.info("Restored the visitor's session on demo exit", { userId: priorSession.userId });
    analytics.capture(priorSession.userId, "demo.exited", { outcome: "restored" });
    return c.redirect(env.APP_URL);
});

interface ParkableSession {
    userId: string;
    token: string;
    expiresAt: Date;
}

/** The session to hand back on exit, or undefined for a visitor who arrived signed out. */
function resolveParkableSession(
    currentSession: { user: { id: string }; session: { token: string; expiresAt: Date } } | null,
): ParkableSession | undefined {
    if (currentSession == null) return undefined;
    return {
        userId: currentSession.user.id,
        token: currentSession.session.token,
        expiresAt: currentSession.session.expiresAt,
    };
}

/** Normalises the `?source=` an in-app entry point carries; anything else is the public CTA. */
function resolveEntrySource(source: string | undefined): string {
    if (source != null && DEMO_ENTRY_SOURCES.has(source)) return source;
    return DEFAULT_DEMO_ENTRY_SOURCE;
}

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
async function setSessionCookie(c: Context, token: string): Promise<void> {
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
