import { ensureBillingProvisioning } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { toSlug } from "@autonoma/utils";
import { redisStorage } from "@better-auth/redis-storage";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { apiKey, organization } from "better-auth/plugins";
import type Redis from "ioredis";
import { env } from "./env";
import { SignupHooks } from "./signup-hooks/signup-hooks";

const INTERNAL_DOMAIN = `@${env.INTERNAL_DOMAIN}`;

function extractDomain(email: string): string {
    const parts = email.split("@");
    return parts[1] ?? email;
}

function titleCase(str: string): string {
    return str.replace(/[-_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const APP_URL = env.APP_URL;
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
}

export type Auth = ReturnType<typeof buildAuth>;

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
    activeOrganizationId?: string;
};

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
    const existing = await conn.member.findFirst({
        where: { userId },
        select: {
            organizationId: true,
            organization: { select: { name: true, slug: true } },
        },
    });

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
            create: { name: "Autonoma", slug: "autonoma", domain: env.INTERNAL_DOMAIN, status: "approved" },
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
            create: { name, slug, domain: isPersonalDomain ? email : domain, status: "approved" },
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

export function buildAuth({ redisClient, conn }: BuildAuthParams) {
    const signupHooks = new SignupHooks({
        resendApiKey: env.RESEND_API_KEY,
        resendAudienceId: env.RESEND_AUDIENCE_ID,
        resendFromEmail: env.RESEND_FROM_EMAIL,
        calLink: env.CAL_ONBOARDING_LINK,
        slackBotToken: env.SLACK_BOT_TOKEN,
        discordInviteUrl: env.DISCORD_INVITE_URL,
    });

    return betterAuth({
        basePath: "/v1/auth",
        database: prismaAdapter(conn, { provider: "postgresql" }),
        secondaryStorage: redisStorage({
            client: redisClient,
            keyPrefix: "better-auth:",
        }),
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
        session: {},
        trustedOrigins: (request) => {
            const origin = request?.headers.get("origin") ?? "";
            const domainEscaped = env.INTERNAL_DOMAIN.replace(/\./g, "\\.");
            const dynamicPattern = new RegExp(`^https://alpha-[a-f0-9]+\\.(?:alpha\\.)?${domainEscaped}$`);
            return [...STATIC_ORIGINS, ...(dynamicPattern.test(origin) ? [origin] : [])];
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
        },
        databaseHooks: {
            user: {
                create: {
                    after: async (user) => {
                        const result = await ensureOrgMembership(conn, user.id, user.email, user.name);

                        if (result.isNewUser) {
                            // Fire-and-forget: signup hooks run async and never block auth
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
                        }
                    },
                },
            },
            session: {
                create: {
                    before: async (session) => {
                        const user = await conn.user.findUnique({
                            where: { id: session.userId },
                            select: { email: true, name: true },
                        });

                        if (user == null) throw new Error("User not found");

                        const result = await ensureOrgMembership(conn, session.userId, user.email, user.name);

                        if (!result.isNewUser) {
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
                        }

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
        ],
    });
}
