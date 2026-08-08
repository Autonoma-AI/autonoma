import { ensureBillingProvisioning } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { isPreviewOrigin } from "@autonoma/types";
import { toSlug } from "@autonoma/utils";
import { apiKey } from "@better-auth/api-key";
import { redisStorage } from "@better-auth/redis-storage";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { jwt, mcp, oAuthProxy, organization } from "better-auth/plugins";
import type { CookieOptions } from "hono/utils/cookie";
import type Redis from "ioredis";
import { env } from "./env";
import { PlatformEventEmitter } from "./posthog/emit-platform-events";
import { SignupHooks } from "./signup-hooks/signup-hooks";
import { vercelPreferredOrgKey } from "./vercel-marketplace/vercel-helpers";

// Path prefixes better-auth serves an OAuth callback on. The segment after the
// prefix is the provider id ("google", "github"), which is what a signup/login
// is attributed to - see resolveAuthProvider.
const OAUTH_CALLBACK_PATH_PREFIXES = ["/callback/", "/oauth2/callback/"];
const EMAIL_PROVIDER = "email";
// Sessions created outside a better-auth endpoint (Vercel SSO calls
// internalAdapter.createSession directly) have no endpoint context to attribute
// to. Those flows emit their own events with VERCEL_PROVIDER.
const UNKNOWN_PROVIDER = "unknown";

const INTERNAL_DOMAIN = `@${env.INTERNAL_DOMAIN}`;

// Password sign-in/sign-up is otherwise disabled in production (social SSO
// only) - this allowlist carves out an exception for non-SSO test
// accounts (e.g. a marketplace reviewer) without opening password auth to
// real users. Enforced in the `hooks.before` middleware below.
const TEST_ACCOUNT_ALLOWED_EMAILS = new Set(
    (env.TEST_ACCOUNT_ALLOWED_EMAILS ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.length > 0),
);

function extractDomain(email: string): string {
    const parts = email.split("@");
    return parts[1] ?? email;
}

function titleCase(str: string): string {
    return str.replace(/[-_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The `:id` route param, from a better-auth context whose `params` is typed too loosely
 * to read directly - the database hooks and the endpoint middleware disagree on its
 * shape, so this narrows at the boundary instead of trusting either.
 */
function readProviderParam(params: unknown): string | undefined {
    if (typeof params !== "object" || params == null) return undefined;
    const id = Reflect.get(params, "id");
    return typeof id === "string" ? id : undefined;
}

/**
 * The auth method a `platform_signup` / `platform_login` event should be
 * attributed to. Social sign-in resolves on better-auth's `/callback/:id`
 * route, where `:id` is the provider id, so this keeps reporting the provider
 * actually used as more are added, instead of naming one of them.
 */
function resolveAuthProvider(path?: string, providerId?: string): string {
    if (path == null) return UNKNOWN_PROVIDER;
    if (path === "/sign-in/email" || path === "/sign-up/email") return EMAIL_PROVIDER;

    const isOAuthCallback = OAUTH_CALLBACK_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (!isOAuthCallback) return UNKNOWN_PROVIDER;

    return providerId ?? UNKNOWN_PROVIDER;
}

const APP_URL = env.APP_URL;
// The API's own origin, where /v1/auth is actually served - falls back to
// APP_URL when the UI and API share one origin (prod/beta behind a single
// ingress). Diverges in local dev (UI :3000, API :4000) and previewkit
// (separate UI/API deploys) - see BETTER_AUTH_URL in .env.example and .preview.yaml.
const AUTH_BASE_URL = env.BETTER_AUTH_URL ?? APP_URL;
// The origin advertised as the OAuth `resource` in the MCP protected-resource
// metadata. Better Auth otherwise derives `resource` from `baseURL` (the AS
// origin, APP_URL) - wrong when MCP clients connect to the dedicated `api.<host>`
// origin off CloudFront, since a strict client rejects a resource that doesn't
// match the host it dialed. Falls back to the API's own origin when unset.
//
// Exported because the agent discovery catalog advertises the same origin. Re-deriving
// the fallback chain there would let the two disagree in exactly the environments where
// the UI and API origins diverge, and a catalog pointing at the wrong host sends agents
// somewhere their OAuth handshake is then rejected.
export const MCP_RESOURCE_URL = env.MCP_RESOURCE_URL ?? AUTH_BASE_URL;
const isProduction = env.NODE_ENV === "production";

function decodeIdTokenPayload(idToken: string): {
    hd?: string;
    sub?: string;
    name?: string;
    email?: string;
    picture?: string;
    email_verified?: boolean;
} {
    try {
        const payload = idToken.split(".")[1];
        if (payload == null) return {};
        const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
        return JSON.parse(decoded) as {
            hd?: string;
            sub?: string;
            name?: string;
            email?: string;
            picture?: string;
            email_verified?: boolean;
        };
    } catch {
        return {};
    }
}

const STATIC_ORIGINS = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());

export interface BuildAuthParams {
    redisClient: Redis;
    conn: PrismaClient;
    platformEvents?: PlatformEventEmitter;
}

export interface Auth {
    handler(request: Request): Promise<Response>;
    api: {
        getSession(params: { headers: Headers }): Promise<{ user: AuthUser; session: AuthSession } | null>;
        /**
         * Verifies an MCP OAuth bearer access token (from the `mcp()` plugin) and
         * returns its claims, or null when absent/invalid. Used by the /v1/mcp
         * resource route to authenticate agents.
         */
        getMcpSession(params: { headers: Headers }): Promise<{ userId: string; scopes: string } | null>;
        /** Backs `oAuthDiscoveryMetadata(auth)` - serves the OAuth AS metadata. */
        getMcpOAuthConfig(...args: unknown[]): unknown;
        /** Backs `oAuthProtectedResourceMetadata(auth)` - serves the protected-resource metadata. */
        getMCPProtectedResource(...args: unknown[]): unknown;
    };
    $context: Promise<{
        secondaryStorage?: {
            get(key: string): unknown;
            set(key: string, value: string, ttl?: number): unknown;
        };
        internalAdapter: {
            listSessions(userId: string): Promise<AuthSession[]>;
            createSession(userId: string): Promise<AuthSession>;
            /**
             * Resolves a session token wherever better-auth actually keeps it: Redis is the
             * read path (`secondaryStorage` below) and the `session` table is the durable
             * copy behind it, so neither alone is authoritative. Use this rather than a
             * Prisma lookup to answer "is this token still a live session?".
             */
            findSession(token: string): Promise<{ session: AuthSession } | null>;
            /**
             * Ends a session everywhere better-auth keeps it (Redis and the `session` table). Used
             * when a user loses their last membership: a session with no organization to fall back
             * to cannot be left pointing at one they are no longer in.
             */
            deleteSession(token: string): Promise<void>;
            /**
             * Writes session fields to every store a session lives in: the Redis cache, the
             * `active-sessions-<userId>` index beside it, and - because
             * `session.storeSessionInDatabase` is on - the durable `session` row. Use this rather
             * than `secondaryStorage.set`, which reaches only the cache and silently does nothing
             * once Redis has evicted the entry.
             */
            updateSession(token: string, session: { activeOrganizationId?: string }): Promise<unknown>;
        };
        // Cookie metadata (name + serialization attributes) for the session-token
        // cookie, as configured by the `secondaryStorage`/cookie-cache options
        // passed to `betterAuth()`. Used to set a session cookie for a session
        // created directly via `internalAdapter.createSession` (bypassing the
        // normal sign-in endpoints, e.g. after verifying a Vercel SSO token).
        authCookies: {
            sessionToken: { name: string; attributes: CookieOptions };
        };
        secret: string;
    }>;
}

export type AuthUser = {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image?: string | null;
    createdAt: Date;
    updatedAt: Date;
    role: string;
};

export type AuthSession = {
    id: string;
    userId: string;
    expiresAt: Date;
    token: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    activeOrganizationId?: string | null;
};

/**
 * Endpoints the `organization()` plugin mounts that would change who belongs to which
 * organization. Every membership change has to go through `organization.*` in tRPC, which enforces
 * what the plugin's versions do not: an invitation is matched against the signed-in user's own
 * email, leaving is refused when it would strand an organization, and losing a membership moves or
 * revokes the sessions that were acting as it - without which a removed user keeps full access
 * until their session expires.
 *
 * The plugin's read endpoint (`list`) stays open - it grants nothing.
 */
const DISABLED_ORGANIZATION_PATHS: ReadonlySet<string> = new Set([
    "/organization/invite-member",
    "/organization/accept-invitation",
    "/organization/reject-invitation",
    "/organization/cancel-invitation",
    "/organization/add-member",
    "/organization/remove-member",
    "/organization/leave",
    // Replaced by `organization.setActive`, which additionally persists the choice to
    // `user.lastOrganizationId`. Leaving the plugin's version reachable would let a switch happen
    // without being remembered, so the next sign-in would silently land somewhere else.
    "/organization/set-active",
]);

function isDisabledOrganizationPath(path: string): boolean {
    return DISABLED_ORGANIZATION_PATHS.has(path);
}

const PERSONAL_EMAIL_DOMAINS = new Set(["gmail.com"]);

interface OrgMembershipResult {
    organizationId: string;
    orgName: string;
    orgSlug: string;
    isNewUser: boolean;
}

async function ensureOrgMembership(
    conn: PrismaClient,
    userId: string,
    email: string,
    displayName?: string,
): Promise<OrgMembershipResult> {
    // A blank email would key the org below on an empty domain, upserting everyone who
    // ever arrives without one into a single shared organization - as its owner. Entra
    // is the realistic source: it does not emit an `email` claim for managed users by
    // default. Fail the sign-in instead; a provider that cannot say who someone is has
    // not identified them.
    //
    // Runs before the reads below, not after: they resolve which organization this session acts as,
    // and there is nothing to resolve for someone the provider could not identify.
    if (email.trim() === "") {
        logger.error("Refusing to resolve an organization for a blank email", { extra: { userId } });
        throw new APIError("BAD_REQUEST", {
            message: "Your account did not provide an email address, which is required to sign in.",
        });
    }

    // Which organization a new session starts in: the one this account last chose, falling back to
    // its oldest membership.
    //
    // The fallback is ordered rather than a bare `findFirst` because an account can belong to
    // several organizations, and an unordered read returns whatever Postgres feels like - it drifted
    // between sign-ins for the same user, which is why the Vercel path needed `vercelPreferredOrgKey`
    // in Redis to force a specific org. `lastOrganizationId` is joined through `member` so a
    // remembered choice the user is no longer a member of is ignored rather than trusted.
    const user = await conn.user.findUnique({
        where: { id: userId },
        select: { lastOrganizationId: true },
    });

    const remembered =
        user?.lastOrganizationId != null
            ? await conn.member.findUnique({
                  where: { userId_organizationId: { userId, organizationId: user.lastOrganizationId } },
                  select: {
                      organizationId: true,
                      organization: { select: { name: true, slug: true } },
                  },
              })
            : null;

    const existing =
        remembered ??
        (await conn.member.findFirst({
            where: { userId },
            select: {
                organizationId: true,
                organization: { select: { name: true, slug: true } },
            },
            orderBy: { createdAt: "asc" },
        }));

    if (existing != null) {
        await ensureBillingProvisioning(conn, existing.organizationId);
        return {
            organizationId: existing.organizationId,
            orgName: existing.organization.name,
            orgSlug: existing.organization.slug,
            isNewUser: false,
        };
    }

    logger.info(`No membership found for user ${userId} - creating org on login`);

    const isInternal = email.endsWith(INTERNAL_DOMAIN);
    let orgId: string;
    let orgName: string;
    let orgSlug: string;

    if (isInternal) {
        const org = await conn.organization.upsert({
            where: { slug: "autonoma" },
            update: {},
            create: {
                name: "Autonoma",
                slug: "autonoma",
                domain: env.INTERNAL_DOMAIN,
                status: "approved",
                nameConfirmedAt: new Date(),
            },
        });
        orgId = org.id;
        orgName = org.name;
        orgSlug = org.slug;

        await conn.user.update({
            where: { id: userId },
            data: { role: "admin" },
        });
    } else {
        const domain = extractDomain(email);
        const isPersonalDomain = PERSONAL_EMAIL_DOMAINS.has(domain);
        const name = isPersonalDomain && displayName != null ? displayName : titleCase(domain.split(".")[0] ?? domain);
        const slug = toSlug(isPersonalDomain && displayName != null ? displayName : domain);
        const org = await conn.organization.upsert({
            where: { domain: isPersonalDomain ? email : domain },
            update: {},
            create: {
                name,
                slug,
                domain: isPersonalDomain ? email : domain,
                status: "approved",
                // A name derived from a real email domain is the company's own name and needs no
                // confirming. A personal-email org is named after whoever signed up first, who is
                // not necessarily whose organization it is, so it stays unconfirmed and gets asked.
                nameConfirmedAt: isPersonalDomain ? undefined : new Date(),
            },
        });
        orgId = org.id;
        orgName = org.name;
        orgSlug = org.slug;
    }

    await conn.member.upsert({
        where: { userId_organizationId: { userId, organizationId: orgId } },
        update: {},
        create: { userId, organizationId: orgId, role: "owner" },
    });

    await ensureBillingProvisioning(conn, orgId);

    return { organizationId: orgId, orgName, orgSlug, isNewUser: true };
}

/**
 * Resolves which org a new session should land in. When a Vercel SSO login
 * stashed a preferred org id in Redis (see `vercelPreferredOrgKey`), and that
 * org still exists, the session uses it directly - this is what lets a
 * multi-org Vercel user land in the org tied to the Vercel team/installation
 * they're authenticating from, rather than the first org `ensureOrgMembership`
 * would otherwise pick. Falls back to `ensureOrgMembership` in every other case.
 */
async function resolveSessionOrg(
    conn: PrismaClient,
    userId: string,
    email: string,
    name: string | undefined,
    preferredOrgId: string | null,
): Promise<OrgMembershipResult> {
    if (preferredOrgId != null) {
        const org = await conn.organization.findUnique({
            where: { id: preferredOrgId },
            select: { name: true, slug: true },
        });
        if (org != null) {
            await ensureBillingProvisioning(conn, preferredOrgId);
            logger.info("Using Vercel preferred org for session", { userId, organizationId: preferredOrgId });
            return { organizationId: preferredOrgId, orgName: org.name, orgSlug: org.slug, isNewUser: false };
        }
    }
    return ensureOrgMembership(conn, userId, email, name);
}

const SOCIAL_PROVIDER_IDS = ["google", "github", "microsoft"] as const;
export type SocialProviderId = (typeof SOCIAL_PROVIDER_IDS)[number];
interface GithubProviderConfig {
    clientId: string;
    clientSecret: string;
}

/**
 * GitHub OAuth app credentials, or undefined when this environment has none.
 * better-auth skips a social provider whose config is undefined, so sign-in
 * stays Google-only wherever GITHUB_CLIENT_ID/SECRET are unset.
 */
function githubProvider(): GithubProviderConfig | undefined {
    const clientId = env.GITHUB_CLIENT_ID;
    const clientSecret = env.GITHUB_CLIENT_SECRET;
    if (clientId == null || clientSecret == null) {
        logger.info("GitHub OAuth credentials not configured - GitHub sign-in is disabled");
        return undefined;
    }
    return { clientId, clientSecret };
}

interface MicrosoftProviderConfig {
    clientId: string;
    clientSecret: string;
    tenantId: string;
}

/**
 * Microsoft Entra ID credentials, or undefined where they aren't provisioned. Same
 * contract as {@link githubProvider}: better-auth skips a provider whose config is
 * undefined, and the login page hides the button to match.
 */
function microsoftProvider(): MicrosoftProviderConfig | undefined {
    const clientId = env.MICROSOFT_CLIENT_ID;
    const clientSecret = env.MICROSOFT_CLIENT_SECRET;
    if (clientId == null || clientSecret == null) {
        logger.info("Microsoft OAuth credentials not configured - Microsoft sign-in is disabled");
        return undefined;
    }
    return { clientId, clientSecret, tenantId: env.MICROSOFT_TENANT_ID };
}

// Resolved once: each builder logs when it finds nothing, and betterAuth and
// ENABLED_SOCIAL_PROVIDERS must be built from the same answer.
const GITHUB_PROVIDER = githubProvider();
const MICROSOFT_PROVIDER = microsoftProvider();

function resolveEnabledSocialProviders(): SocialProviderId[] {
    // Google's credentials are required by env validation, so it is always available.
    const providers: SocialProviderId[] = ["google"];
    if (GITHUB_PROVIDER != null) providers.push("github");
    if (MICROSOFT_PROVIDER != null) providers.push("microsoft");
    return providers;
}

/**
 * The providers this environment can actually complete a sign-in with, derived from
 * the very config betterAuth is built with so the two cannot drift. The login page
 * reads this: a provider whose credentials are absent would otherwise render as a
 * button that dead-ends in better-auth's "Provider not found".
 */
export const ENABLED_SOCIAL_PROVIDERS: readonly SocialProviderId[] = resolveEnabledSocialProviders();

const SOCIAL_PROVIDER_LABELS: Record<SocialProviderId, string> = {
    google: "Google",
    microsoft: "Microsoft",
    github: "GitHub",
};

/**
 * The sign-in options actually on offer, written out for the message that refuses
 * password auth. Derived rather than spelled out, so an environment without a GitHub
 * OAuth app does not tell the reader to use a button it never rendered.
 */
function formatEnabledSocialProviders(): string {
    const labels = ENABLED_SOCIAL_PROVIDERS.map((id) => SOCIAL_PROVIDER_LABELS[id]);
    const last = labels.at(-1);
    if (last == null) return "social";
    if (labels.length === 1) return last;
    return `${labels.slice(0, -1).join(", ")} or ${last}`;
}

/**
 * OAuth proxying, which exists because a provider will only redirect to callback URLs
 * registered ahead of time - and an alpha's hostname is minted per PR, so it can never
 * be one of them. Every environment sends the provider production's callback URL and
 * gets the resulting profile handed back, encrypted and short-lived, at its own origin,
 * where it mints its own session.
 *
 * Registered only when OAUTH_PROXY_PRODUCTION_URL is set. That is not just an on/off
 * switch: with the plugin present but no productionURL, better-auth still rewrites the
 * callback to /oauth-proxy-callback while leaving the provider pointed at this origin,
 * which breaks sign-in outright. `currentURL` is pinned to APP_URL rather than left to
 * be inferred, because the fallback reads the request's Host header - the API is reached
 * on a different host than the app in prod/beta, and that origin is what receives the
 * profile payload.
 */
function oauthProxyPlugins() {
    const productionURL = env.OAUTH_PROXY_PRODUCTION_URL;
    if (productionURL == null) {
        logger.info("OAuth proxy disabled - this environment signs in against its own OAuth app");
        return [];
    }
    logger.info("OAuth proxy enabled", { extra: { productionURL, currentURL: APP_URL } });
    return [oAuthProxy({ productionURL, currentURL: APP_URL, secret: env.OAUTH_PROXY_SECRET })];
}

export function buildAuth({ redisClient, conn, platformEvents: injectedPlatformEvents }: BuildAuthParams): Auth {
    const signupHooks = new SignupHooks({
        resendApiKey: env.RESEND_API_KEY,
        resendAudienceId: env.RESEND_AUDIENCE_ID,
        resendFromEmail: env.RESEND_FROM_EMAIL,
        calLink: env.CAL_ONBOARDING_LINK,
        slackBotToken: env.SLACK_BOT_TOKEN,
        discordInviteUrl: env.DISCORD_INVITE_URL,
    });

    const platformEvents = injectedPlatformEvents ?? new PlatformEventEmitter(conn);

    return betterAuth({
        // Explicit origin (not inferred from the request) so the MCP OAuth
        // discovery metadata has an `issuer`/`baseURL` - without it better-auth's
        // oAuthDiscoveryMetadata throws and the .well-known endpoints return null,
        // and the WWW-Authenticate challenge is built with the wrong (http) scheme
        // behind the TLS-terminating ingress. Must be this service's own origin
        // (AUTH_BASE_URL), not APP_URL - see its definition above.
        baseURL: AUTH_BASE_URL,
        basePath: "/v1/auth",
        database: prismaAdapter(conn, { provider: "postgresql" }),
        secondaryStorage: redisStorage({
            client: redisClient,
            // Namespaced because every environment shares one Redis (system/redis) and
            // `session` is unset, so `storeSessionInDatabase` is off and sessions live
            // ONLY here. An unnamespaced prefix therefore made one session store for the
            // whole fleet: a session minted by an alpha - running unreviewed PR code -
            // was a valid production session. Changing this prefix invalidates every
            // session in the environment that adopts it.
            keyPrefix: `better-auth:${env.NAMESPACE}:`,
        }),
        emailAndPassword: {
            enabled: env.PREVIEWKIT_ENV || TEST_ACCOUNT_ALLOWED_EMAILS.size > 0,
        },
        hooks: {
            // Password sign-in/sign-up in production is reserved for
            // TEST_ACCOUNT_ALLOWED_EMAILS - every other account must use one of the
            // social providers. Previewkit environments (env.PREVIEWKIT_ENV) are
            // unaffected; this only gates the two email/password endpoints.
            before: createAuthMiddleware(async (ctx) => {
                if (isDisabledOrganizationPath(ctx.path)) {
                    logger.warn("Blocked a better-auth organization membership endpoint", {
                        extra: { path: ctx.path },
                    });
                    throw new APIError("NOT_FOUND", {
                        message: "Not found",
                    });
                }

                if (env.PREVIEWKIT_ENV) return;
                if (ctx.path !== "/sign-up/email" && ctx.path !== "/sign-in/email") return;

                const email = typeof ctx.body?.email === "string" ? ctx.body.email.trim().toLowerCase() : "";
                if (TEST_ACCOUNT_ALLOWED_EMAILS.has(email)) return;

                throw new APIError("FORBIDDEN", {
                    message: `Password sign-in is not available for this account. Use ${formatEnabledSocialProviders()} sign-in instead.`,
                });
            }),
        },
        user: {
            additionalFields: {
                role: {
                    type: "string",
                    defaultValue: "user",
                    input: false,
                },
            },
        },
        rateLimit: {
            window: 60000,
            max: 10000,
        },
        session: {
            // Redis stays the read path; this makes Postgres the durable copy behind it.
            // Without it a Redis miss is an immediate logout (findSession returns null),
            // and the shared Redis runs `maxmemory 400mb` with `allkeys-lru` - so a live
            // session can be evicted under memory pressure from anything else in the
            // cluster, signing a user out with no error and nothing to trace. With it,
            // that miss falls through to the session table instead.
            storeSessionInDatabase: true,
        },
        trustedOrigins: (request) => {
            const origin = request?.headers.get("origin") ?? "";
            const domainEscaped = env.INTERNAL_DOMAIN.replace(/\./g, "\\.");
            const alphaPattern = new RegExp(`^https://alpha-[a-f0-9]+\\.(?:alpha\\.)?${domainEscaped}$`);
            // Hash-only alpha hosts: <hash>.alpha.<domain> (no `alpha-` prefix).
            const hashAlphaPattern = new RegExp(`^https://[a-f0-9]+\\.alpha\\.${domainEscaped}$`);
            const isDynamic =
                alphaPattern.test(origin) ||
                hashAlphaPattern.test(origin) ||
                isPreviewOrigin(origin, env.INTERNAL_DOMAIN);
            return [...STATIC_ORIGINS, ...(isDynamic ? [origin] : [])];
        },
        advanced: {
            crossSubDomainCookies: {
                enabled: isProduction,
                domain: `.${env.INTERNAL_DOMAIN}`,
            },
        },
        onAPIError: {
            errorURL: `${APP_URL}/login/workspace-required`,
        },
        socialProviders: {
            google: {
                clientId: env.GOOGLE_CLIENT_ID,
                clientSecret: env.GOOGLE_CLIENT_SECRET,
                scope: ["openid", "email", "profile"],
                getUserInfo: async (token) => {
                    if (token.idToken == null) return null;
                    const payload = decodeIdTokenPayload(token.idToken);
                    if (payload.email == null || payload.email === "") return null;

                    return {
                        user: {
                            id: payload.sub ?? "",
                            name: payload.name ?? payload.email ?? "",
                            email: payload.email ?? "",
                            image: payload.picture,
                            emailVerified: payload.email_verified ?? false,
                        },
                        data: payload,
                    };
                },
            },
            github: GITHUB_PROVIDER,
            microsoft: MICROSOFT_PROVIDER,
        },
        databaseHooks: {
            user: {
                create: {
                    after: async (user, context) => {
                        const result = await ensureOrgMembership(conn, user.id, user.email, user.name);

                        try {
                            platformEvents.onUserCreated({
                                userId: user.id,
                                email: user.email,
                                name: user.name,
                                organizationId: result.organizationId,
                                provider: resolveAuthProvider(context?.path, readProviderParam(context?.params)),
                                cookieHeader: context?.headers?.get("cookie") ?? undefined,
                            });
                        } catch (error) {
                            logger.error("Failed to emit platform_signup", { error, userId: user.id });
                        }

                        // This runs only on user creation; the hook itself skips work that's already claimed/completed.
                        void signupHooks
                            .onUserCreated({
                                db: conn,
                                userId: user.id,
                                email: user.email,
                                name: user.name,
                                organizationId: result.organizationId,
                                orgName: result.orgName,
                                orgSlug: result.orgSlug,
                            })
                            .catch((error) => {
                                logger.error("Failed to run signupHooks.onUserCreated", { error, userId: user.id });
                            });
                    },
                },
            },
            session: {
                create: {
                    before: async (session, context) => {
                        const user = await conn.user.findUnique({
                            where: { id: session.userId },
                            select: { email: true, name: true },
                        });

                        if (user == null) throw new Error("User not found");

                        // Check if Vercel SSO has set a preferred org (for multi-org users)
                        const preferredOrgKey = vercelPreferredOrgKey(session.userId);
                        const preferredOrgId = await redisClient.get(preferredOrgKey);

                        const result = await resolveSessionOrg(
                            conn,
                            session.userId,
                            user.email,
                            user.name,
                            preferredOrgId,
                        );

                        try {
                            await platformEvents.onSessionCreated({
                                userId: session.userId,
                                email: user.email,
                                name: user.name,
                                organizationId: result.organizationId,
                                provider: resolveAuthProvider(context?.path, readProviderParam(context?.params)),
                            });
                        } catch (error) {
                            logger.error("Failed to emit platform_login", { error, userId: session.userId });
                        }

                        // This runs on every session creation so it can catch up any signup side-effects that were missed.
                        void signupHooks
                            .onUserAuthenticated({
                                db: conn,
                                userId: session.userId,
                                email: user.email,
                                name: user.name,
                                organizationId: result.organizationId,
                                orgName: result.orgName,
                                orgSlug: result.orgSlug,
                            })
                            .catch((error) => {
                                logger.error("Failed to run signupHooks.onUserAuthenticated", {
                                    error,
                                    userId: session.userId,
                                });
                            });

                        return {
                            data: {
                                ...session,
                                activeOrganizationId: result.organizationId,
                            },
                        };
                    },
                },
            },
        },
        plugins: [
            organization(),
            apiKey({
                schema: {
                    apikey: { modelName: "apiKey" },
                },
            }),
            ...oauthProxyPlugins(),
            // MCP OAuth (Workstream B): turns Better Auth into the OAuth
            // authorization server for the /v1/mcp/* resource servers. `jwt()`
            // signs the access tokens (locally verifiable, no introspection
            // round-trip). Unauthenticated MCP OAuth flows are sent to the UI
            // login page. Adds oauthApplication / oauthAccessToken / oauthConsent
            // (+ jwks) models - run a migration.
            mcp({ loginPage: `${APP_URL}/login`, resource: MCP_RESOURCE_URL }),
            jwt(),
        ],
    });
}
