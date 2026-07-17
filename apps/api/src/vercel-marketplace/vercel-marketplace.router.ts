import { randomBytes } from "node:crypto";
import { ensureBillingProvisioning } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { ThirdPartyError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { toSlug } from "@autonoma/utils";
import type { Context } from "hono";
import { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import { z } from "zod";
import { auth, redisClient } from "../context";
import { env } from "../env";
import { resolveUniqueOrgSlug, vercelPreferredOrgKey } from "./vercel-helpers";

const logger = rootLogger.child({ name: "VercelMarketplaceRouter" });

// ─── Types ─────────────────────────────────────────────────────────────────

interface VercelUserInfo {
    sub: string;
    email: string;
    name: string;
    picture?: string;
}

interface EnsureVercelUserAndOrgParams {
    sub: string;
    email: string;
    name: string;
    picture?: string;
    teamId?: string;
    accessToken: string | null;
    accountId?: string;
    installationId?: string;
}

interface EnsureResult {
    userId: string;
    organizationId: string;
}

interface ResolveOrganizationIdParams {
    userId: string;
    teamId?: string;
    name: string;
    accessToken: string | null;
    accountId?: string;
    installationId?: string;
}

// ─── Vercel API response schemas ──────────────────────────────────────────────

const VercelInstallTokenSchema = z.object({
    access_token: z.string(),
    team_id: z.string().optional(),
});

const VercelSSOTokenSchema = z.object({
    id_token: z.string(),
    // Vercel's SSO token exchange returns `access_token: null` (not omitted) when
    // the SSO login doesn't also grant API access - `.optional()` alone rejects
    // an explicit null, which is what was actually failing parsing here.
    access_token: z.string().nullish(),
});

const VercelUserInfoSchema = z.object({
    sub: z.string(),
    email: z.string(),
    name: z.string().optional(),
    preferred_username: z.string().optional(),
    picture: z.string().optional(),
});

const VercelTeamSchema = z.object({
    name: z.string().optional(),
    slug: z.string().optional(),
});

const SSOJwtPayloadSchema = z.object({
    sub: z.string().optional(),
    email: z.string().optional(),
    name: z.string().optional(),
    preferred_username: z.string().optional(),
    picture: z.string().optional(),
    user_email: z.string().optional(),
    user_name: z.string().optional(),
    installation_id: z.string().optional(),
    account_id: z.string().optional(),
});

const FinalizePayloadSchema = z.object({
    sessionToken: z.string(),
    organizationId: z.string(),
    targetUrl: z.string().optional(),
});

// ─── Runtime validation ───────────────────────────────────────────────────────

function requireVercelCredentials(): { clientId: string; clientSecret: string } {
    if (env.VERCEL_CLIENT_ID == null || env.VERCEL_CLIENT_SECRET == null) {
        throw new Error("VERCEL_CLIENT_ID and VERCEL_CLIENT_SECRET must be configured");
    }
    return { clientId: env.VERCEL_CLIENT_ID, clientSecret: env.VERCEL_CLIENT_SECRET };
}

// ─── Vercel API calls ─────────────────────────────────────────────────────────

async function exchangeInstallCode(
    code: string,
    redirectUri: string,
): Promise<{ accessToken: string; teamId?: string }> {
    logger.info("Exchanging Vercel install code");
    const { clientId, clientSecret } = requireVercelCredentials();

    let res: Response;
    try {
        res = await fetch("https://api.vercel.com/v2/oauth/access_token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                code,
                redirect_uri: redirectUri,
            }),
        });
    } catch (error) {
        logger.error("Network error exchanging Vercel install code", { error });
        throw new ThirdPartyError("vercel", error, "Network error exchanging Vercel install code");
    }

    if (!res.ok) {
        const body = await res.text();
        throw new ThirdPartyError(
            "vercel",
            new Error(`${res.status} ${body}`),
            `Vercel install token exchange failed: ${res.status} ${body}`,
        );
    }

    const data = VercelInstallTokenSchema.parse(await res.json());
    logger.info("Vercel install token exchange succeeded", { hasTeamId: data.team_id != null });

    return { accessToken: data.access_token, teamId: data.team_id };
}

async function exchangeSSOCode(
    code: string,
    state: string,
    redirectUri: string,
): Promise<{ idToken: string; accessToken: string | null }> {
    logger.info("Exchanging Vercel SSO code");
    const { clientId, clientSecret } = requireVercelCredentials();

    let res: Response;
    try {
        res = await fetch("https://api.vercel.com/v1/integrations/sso/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                code,
                state,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: "authorization_code",
            }),
        });
    } catch (error) {
        logger.error("Network error exchanging Vercel SSO code", { error });
        throw new ThirdPartyError("vercel", error, "Network error exchanging Vercel SSO code");
    }

    if (!res.ok) {
        const body = await res.text();
        throw new ThirdPartyError(
            "vercel",
            new Error(`${res.status} ${body}`),
            `Vercel SSO token exchange failed: ${res.status} ${body}`,
        );
    }

    const data = VercelSSOTokenSchema.parse(await res.json());
    logger.info("Vercel SSO token exchange succeeded", {
        hasIdToken: data.id_token != null,
        hasAccessToken: data.access_token != null,
    });

    return { idToken: data.id_token, accessToken: data.access_token ?? null };
}

async function getVercelUserInfo(accessToken: string): Promise<VercelUserInfo> {
    let res: Response;
    try {
        res = await fetch("https://api.vercel.com/login/oauth/userinfo", {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
    } catch (error) {
        logger.error("Network error fetching Vercel user info", { error });
        throw new ThirdPartyError("vercel", error, "Network error fetching Vercel user info");
    }

    if (!res.ok) {
        const body = await res.text();
        throw new ThirdPartyError(
            "vercel",
            new Error(`${res.status} ${body}`),
            `Vercel userinfo failed: ${res.status} ${body}`,
        );
    }

    const data = VercelUserInfoSchema.parse(await res.json());

    return {
        sub: data.sub,
        email: data.email,
        name: data.name ?? data.preferred_username ?? data.email,
        picture: data.picture,
    };
}

function decodeJwtPayload(token: string): z.infer<typeof SSOJwtPayloadSchema> {
    try {
        const part = token.split(".")[1];
        if (part == null) return {};
        const decoded = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
        const result = SSOJwtPayloadSchema.safeParse(JSON.parse(decoded));
        return result.success ? result.data : {};
    } catch (error) {
        logger.debug("Failed to decode SSO JWT payload", { error });
        return {};
    }
}

/** Falls back to the raw `teamId` (used as the display name) if the Vercel lookup fails. */
async function getVercelTeamName(teamId: string, accessToken: string): Promise<string> {
    let res: Response;
    try {
        res = await fetch(`https://api.vercel.com/v2/teams/${teamId}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
    } catch (error) {
        logger.warn("Network error fetching Vercel team name, falling back to teamId", { teamId, error });
        return teamId;
    }

    if (!res.ok) {
        logger.warn("Vercel team lookup failed, falling back to teamId", { teamId, status: res.status });
        return teamId;
    }

    const result = VercelTeamSchema.safeParse(await res.json());
    if (!result.success) {
        logger.warn("Vercel team response failed validation, falling back to teamId", { teamId });
        return teamId;
    }

    return result.data.name ?? result.data.slug ?? teamId;
}

// ─── Org / user resolution ────────────────────────────────────────────────────

async function ensureVercelUserAndOrg(params: EnsureVercelUserAndOrgParams): Promise<EnsureResult> {
    const { sub, email, name, picture, teamId, accessToken, accountId, installationId } = params;

    logger.info("Ensuring Vercel user and org", { email, hasTeamId: teamId != null });

    const user = await db.user.upsert({
        where: { email },
        update: { name, image: picture },
        create: { name, email, emailVerified: true, image: picture, role: "user" },
    });

    // Upsert Vercel account link (no unique constraint, so find-or-create)
    // Note: SSO accessToken is not stored - it's only for authentication flow
    // The actual Vercel API token is stored encrypted in VercelInstallation table
    const existingAccount = await db.account.findFirst({
        where: { providerId: "vercel-marketplace", accountId: sub },
    });

    if (existingAccount == null) {
        await db.account.create({
            data: {
                accountId: sub,
                providerId: "vercel-marketplace",
                userId: user.id,
            },
        });
    } else {
        await db.account.update({
            where: { id: existingAccount.id },
            data: { userId: user.id },
        });
    }

    const organizationId = await resolveOrganizationId({
        userId: user.id,
        teamId,
        name,
        accessToken,
        accountId,
        installationId,
    });

    // Independent once organizationId is known - member linkage and billing
    // provisioning touch unrelated tables.
    await Promise.all([
        db.member.upsert({
            where: { userId_organizationId: { userId: user.id, organizationId } },
            update: {},
            create: { userId: user.id, organizationId, role: "owner" },
        }),
        ensureBillingProvisioning(db, organizationId),
    ]);

    logger.info("Vercel user and org resolved", { userId: user.id, organizationId });

    return { userId: user.id, organizationId };
}

async function resolveOrganizationId(params: ResolveOrganizationIdParams): Promise<string> {
    const { userId, teamId, accessToken, accountId, installationId } = params;

    if (teamId != null) {
        return resolveTeamOrg(teamId, accessToken);
    }

    // Personal account - MUST have installation_id and existing installation to SSO
    // SSO should only work if there's a valid Vercel installation already
    if (installationId != null) {
        const installation = await db.vercelInstallation.findFirst({
            where: { vercelInstallationId: installationId },
            select: { organizationId: true },
        });
        if (installation != null) {
            logger.info("Found existing org via installationId for SSO", {
                installationId,
                organizationId: installation.organizationId,
            });
            return installation.organizationId;
        }

        // No installation found - reject SSO
        logger.error("SSO attempted but no installation found for installationId", { installationId, userId });
        throw new Error("No Vercel installation found. Please install the integration first.");
    }

    // Fallback to accountId (legacy)
    if (accountId != null) {
        const installation = await db.vercelInstallation.findFirst({
            where: { vercelAccountId: accountId },
            select: { organizationId: true },
        });
        if (installation != null) {
            logger.info("Found existing org via accountId fallback", {
                accountId,
                organizationId: installation.organizationId,
            });
            return installation.organizationId;
        }

        logger.error("SSO attempted but no installation found for accountId", { accountId, userId });
        throw new Error("No Vercel installation found for this account. Please install the integration first.");
    }

    // No installation_id or account_id in SSO token - reject
    logger.error("SSO attempted without installation_id or account_id in token", { userId });
    throw new Error("Missing installation_id in SSO token. Cannot authenticate.");
}

async function resolveTeamOrg(teamId: string, accessToken: string | null): Promise<string> {
    const existing = await db.vercelInstallation.findFirst({
        where: { vercelAccountId: teamId },
        select: { organizationId: true },
    });
    if (existing != null) return existing.organizationId;

    if (accessToken == null) {
        throw new Error(`Cannot create org for new Vercel team ${teamId}: no access token available`);
    }

    logger.info("Creating new org for Vercel team", { teamId });

    const teamName = await getVercelTeamName(teamId, accessToken);
    const slug = await resolveUniqueOrgSlug(toSlug(teamName));

    const org = await db.organization.create({
        data: { name: teamName, slug, status: "approved" },
    });

    return org.id;
}

// ─── Session creation ─────────────────────────────────────────────────────────

async function createSession(userId: string, organizationId: string): Promise<string> {
    // Store the desired organization ID in Redis so the auth hook can read it
    // The hook will use this instead of the first org the user is a member of
    const preferredOrgKey = vercelPreferredOrgKey(userId);
    await redisClient.set(preferredOrgKey, organizationId, "EX", 60);

    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession(userId);

    // Clean up the preferred org key
    await redisClient.del(preferredOrgKey);

    logger.info("Session created for Vercel user", {
        userId,
        organizationId,
        sessionId: session.id,
        hasToken: session.token != null,
        tokenLength: session.token?.length,
    });
    return session.token;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const vercelMarketplaceRouter = new Hono();

/**
 * Validates the `url` param Vercel echoes back on an SSO callback (originally
 * supplied by us to `buildVercelSsoRedirectUrl`). This endpoint is hit
 * unauthenticated, so a same-origin check is required to rule out it being
 * used as an open redirect.
 */
function resolveSafeTargetUrl(raw: string | undefined): string | undefined {
    if (raw == null) return undefined;

    try {
        const parsed = new URL(raw);
        const appOrigin = new URL(env.APP_URL).origin;
        if (parsed.origin !== appOrigin) {
            logger.warn("Ignoring Vercel SSO target url with mismatched origin", { raw, appOrigin });
            return undefined;
        }
        return parsed.toString();
    } catch (error) {
        logger.warn("Ignoring malformed Vercel SSO target url", { raw, error });
        return undefined;
    }
}

vercelMarketplaceRouter.get("/callback", async (c) => {
    const code = c.req.query("code");
    const mode = c.req.query("mode");
    const state = c.req.query("state") ?? "";
    const targetUrl = resolveSafeTargetUrl(c.req.query("url"));

    logger.info("Vercel marketplace callback received", {
        mode,
        hasCode: code != null,
        hasTargetUrl: targetUrl != null,
    });

    if (code == null) {
        logger.warn("Vercel callback missing code param");
        return c.redirect(`${env.APP_URL}/login?error=missing_code`);
    }

    // In dev, use APP_URL (port 3000 via Vite proxy) so cookies are set on the app origin.
    // In prod, VERCEL_REDIRECT_URI must be set explicitly.
    const redirectUri = env.VERCEL_REDIRECT_URI ?? `${env.APP_URL}/v1/vercel/callback`;

    try {
        if (mode === "sso") {
            return await handleSsoCallback(c, code, state, redirectUri, targetUrl);
        }
        return await handleInstallCallback(c, code, redirectUri);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        logger.error("Vercel marketplace callback failed", { message, stack, mode });
        return c.redirect(`${env.APP_URL}/login?error=vercel_auth_failed`);
    }
});

async function handleSsoCallback(
    c: Context,
    code: string,
    state: string,
    redirectUri: string,
    targetUrl: string | undefined,
): Promise<Response> {
    const { idToken, accessToken } = await exchangeSSOCode(code, state, redirectUri);
    logger.info("SSO id_token received, decoding payload");

    const payload = decodeJwtPayload(idToken);
    // Vercel uses user_email/user_name, falling back to standard OIDC email/name
    const email = payload.user_email ?? payload.email;
    const name = payload.user_name ?? payload.name ?? payload.preferred_username;

    logger.info("SSO JWT payload decoded", {
        hasSub: payload.sub != null,
        hasEmail: email != null,
        hasName: name != null,
        sub: payload.sub,
        email,
    });

    if (payload.sub == null || email == null) {
        throw new Error("SSO id_token missing sub or email");
    }

    const userInfo: VercelUserInfo = {
        sub: payload.sub,
        email,
        name: name ?? email,
        picture: payload.picture,
    };

    // For SSO, look up team from existing installation since token doesn't include team_id
    logger.info("Looking up existing Vercel account", { sub: payload.sub });
    const existingAccount = await db.account.findFirst({
        where: { providerId: "vercel-marketplace", accountId: payload.sub },
        select: { userId: true },
    });

    logger.info("Existing account lookup result", { found: existingAccount != null });

    const teamId = await resolveTeamIdFromExistingAccount(existingAccount?.userId);

    logger.info("Ensuring Vercel user and org for SSO", {
        email: userInfo.email,
        teamId,
        accountId: payload.account_id,
        installationId: payload.installation_id,
    });
    const { userId, organizationId } = await ensureVercelUserAndOrg({
        ...userInfo,
        teamId,
        accessToken,
        accountId: payload.account_id,
        installationId: payload.installation_id,
    });

    logger.info("SSO user and org resolved", { userId, organizationId });
    const sessionToken = await createSession(userId, organizationId);
    logger.info("SSO session created", { userId, organizationId });

    return c.redirect(buildFinalizeUrl(sessionToken, organizationId, targetUrl));
}

async function resolveTeamIdFromExistingAccount(
    existingAccountUserId: string | undefined,
): Promise<string | undefined> {
    if (existingAccountUserId == null) {
        logger.info("No existing installation found, will use personal account resolution");
        return undefined;
    }

    const installation = await db.vercelInstallation.findFirst({
        where: { userId: existingAccountUserId },
        select: { vercelAccountId: true },
    });

    if (installation == null) {
        logger.info("No existing installation found, will use personal account resolution");
        return undefined;
    }

    logger.info("Resolved team from existing installation", { teamId: installation.vercelAccountId });
    return installation.vercelAccountId;
}

async function handleInstallCallback(c: Context, code: string, redirectUri: string): Promise<Response> {
    const { accessToken, teamId } = await exchangeInstallCode(code, redirectUri);
    const userInfo = await getVercelUserInfo(accessToken);

    const { userId, organizationId } = await ensureVercelUserAndOrg({
        ...userInfo,
        teamId,
        accessToken,
    });

    const sessionToken = await createSession(userId, organizationId);

    // No explicit target - finalize defaults to /onboarding?origin=vercel.
    return c.redirect(buildFinalizeUrl(sessionToken, organizationId));
}

// GET /v1/vercel/finalize - Sets session cookie from the app origin (via Vite proxy in dev)
// This solves the cross-origin cookie problem: callback runs on API origin (ngrok/port 4000),
// but the cookie must be set from APP_URL origin so the browser sends it with app requests.
vercelMarketplaceRouter.get("/finalize", async (c) => {
    const oneTimeCode = c.req.query("code");

    if (oneTimeCode == null) {
        logger.warn("Finalize called without code");
        return c.redirect(`${env.APP_URL}/login?error=missing_code`);
    }

    const redisKey = `vercel-finalize:${oneTimeCode}`;
    const payload = await redisClient.get(redisKey);

    if (payload == null) {
        logger.warn("Finalize code not found or expired", { oneTimeCode });
        return c.redirect(`${env.APP_URL}/login?error=vercel_auth_failed`);
    }

    await redisClient.del(redisKey);

    let sessionToken: string;
    let organizationId: string | undefined;
    let targetUrl: string | undefined;
    const parsed = FinalizePayloadSchema.safeParse(JSON.parse(payload));
    if (parsed.success) {
        sessionToken = parsed.data.sessionToken;
        organizationId = parsed.data.organizationId;
        targetUrl = parsed.data.targetUrl;
    } else {
        // Legacy format - just session token string
        sessionToken = payload;
    }

    logger.info("Finalizing Vercel session via app origin", { organizationId, hasTargetUrl: targetUrl != null });
    await setSessionCookie(c, sessionToken);
    // Any Vercel-origin session with no explicit target (a fresh install, or an
    // SSO callback where Vercel echoes no `url`) lands in onboarding rather than
    // the dashboard. appendVercelOrigin tags it so the preview-environment steps
    // are streamlined for marketplace-origin users. An explicit target (e.g. the
    // deployment-details SSO link to /app/<slug>/...) is still honored.
    const destination = targetUrl ?? `${env.APP_URL}/onboarding`;
    return c.redirect(appendVercelOrigin(destination));
});

/**
 * Tags the post-auth destination with `origin=vercel` so onboarding knows the
 * user arrived from the Vercel marketplace and can streamline the
 * preview-provider steps (skip the PreviewKit/custom choice and the quiz's
 * provider picker, preselecting Vercel). `targetUrl` is already same-origin
 * validated by {@link resolveSafeTargetUrl}.
 */
function appendVercelOrigin(targetUrl: string): string {
    try {
        const url = new URL(targetUrl);
        url.searchParams.set("origin", "vercel");
        return url.toString();
    } catch (error) {
        logger.warn("Could not append origin to Vercel finalize target", { targetUrl, error });
        return targetUrl;
    }
}

function buildFinalizeUrl(sessionToken: string, organizationId: string, targetUrl?: string): string {
    const oneTimeCode = randomBytes(16).toString("hex");
    const redisKey = `vercel-finalize:${oneTimeCode}`;
    const payload = JSON.stringify({ sessionToken, organizationId, targetUrl });
    // Fire-and-forget - TTL 60s, enough for the redirect chain
    void redisClient.set(redisKey, payload, "EX", 60).catch((error) => {
        logger.error("Failed to store Vercel finalize code in Redis", { oneTimeCode, organizationId, error });
    });
    logger.info("Stored finalize code in Redis", { oneTimeCode, organizationId, hasTargetUrl: targetUrl != null });
    return `${env.APP_URL}/v1/vercel/finalize?code=${oneTimeCode}`;
}

async function setSessionCookie(c: Context, token: string): Promise<void> {
    const ctx = await auth.$context;
    const { name, attributes } = ctx.authCookies.sessionToken;
    // Use better-auth's own cookie name and secret so the signed cookie matches
    // what better-auth expects when reading it back via getSignedCookie.
    await setSignedCookie(c, name, token, ctx.secret, {
        httpOnly: true,
        sameSite: "Lax",
        secure: attributes.secure,
        path: "/",
        domain: attributes.domain ?? undefined,
    });
}
