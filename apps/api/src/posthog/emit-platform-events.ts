import { analytics as analyticsSingleton, type PostHogAnalytics } from "@autonoma/analytics";
import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";

/**
 * Cookie names reused from the website side so blog → platform attribution survives the cross-domain jump.
 */
const REFERRING_BLOG_COOKIE = "autonoma_referring_blog";
const HYPOTHESIS_COOKIE = "autonoma_hypothesis";

export interface AttributionCookies {
    referringBlog?: string;
    hypothesis?: string;
}

/**
 * Parses the raw `Cookie` request header and extracts only the attribution cookies we care about.
 * Returns an empty object when the header is missing or malformed - attribution is always optional.
 */
export function parseAttributionCookies(cookieHeader: string | null | undefined): AttributionCookies {
    if (cookieHeader == null || cookieHeader === "") return {};

    const parsed: AttributionCookies = {};

    for (const rawPair of cookieHeader.split(";")) {
        const pair = rawPair.trim();
        if (pair === "") continue;

        const separatorIndex = pair.indexOf("=");
        if (separatorIndex <= 0) continue;

        const name = pair.slice(0, separatorIndex).trim();
        const rawValue = pair.slice(separatorIndex + 1).trim();

        let value: string;
        try {
            value = decodeURIComponent(rawValue);
        } catch {
            value = rawValue;
        }

        if (value === "") continue;

        if (name === REFERRING_BLOG_COOKIE) parsed.referringBlog = value;
        else if (name === HYPOTHESIS_COOKIE) parsed.hypothesis = value;
    }

    return parsed;
}

export interface SignupEventParams {
    userId: string;
    email: string;
    name: string;
    organizationId: string;
    provider: string;
    cookieHeader?: string;
}

export interface LoginEventParams {
    userId: string;
    organizationId: string;
    provider: string;
}

/**
 * Server-side emitter for `platform_signup` and `platform_login` PostHog events.
 *
 * Classification rule:
 *  - `platform_signup` fires exactly once, when a new User row is inserted.
 *  - `platform_login` fires on every session creation EXCEPT the first session for a user
 *    (which is the signup-flow session and would otherwise double-count with `platform_signup`).
 *
 * This authoritative server-side classification replaces the previous client-side one that relied on
 * `localStorage`, which was per-device and misclassified cross-device logins as signups.
 */
export class PlatformEventEmitter {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly analytics: PostHogAnalytics = analyticsSingleton,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Called from `databaseHooks.user.create.after`. Fires exactly once per user because the better-auth
     * after-create hook only runs when a new User row is inserted.
     */
    onUserCreated(params: SignupEventParams): void {
        const attribution = parseAttributionCookies(params.cookieHeader);
        const now = new Date().toISOString();

        const eventProperties: Record<string, unknown> = {
            user_id: params.userId,
            email: params.email,
            organization_id: params.organizationId,
            provider: params.provider,
        };
        if (attribution.referringBlog != null) eventProperties.referring_blog = attribution.referringBlog;
        if (attribution.hypothesis != null) eventProperties.hypothesis = attribution.hypothesis;

        const setOnce: Record<string, unknown> = { signup_at: now };
        if (attribution.referringBlog != null) setOnce.signup_referring_blog = attribution.referringBlog;
        if (attribution.hypothesis != null) setOnce.signup_hypothesis = attribution.hypothesis;

        const properties: Record<string, unknown> = {
            ...eventProperties,
            $set: {
                email: params.email,
                name: params.name,
                organization_id: params.organizationId,
                last_login_at: now,
            },
            $set_once: setOnce,
        };

        this.logger.info("Emitting platform_signup", {
            userId: params.userId,
            organizationId: params.organizationId,
            hasReferringBlog: attribution.referringBlog != null,
            hasHypothesis: attribution.hypothesis != null,
        });

        this.analytics.capture(params.userId, "platform_signup", properties);
    }

    /**
     * Called from `databaseHooks.session.create.before`. Emits `platform_login` only if the user already
     * has at least one prior session - otherwise this is the signup-flow session and `platform_signup`
     * covers it.
     */
    async onSessionCreated(params: LoginEventParams & { email: string; name: string }): Promise<void> {
        const priorSessionCount = await this.db.session.count({ where: { userId: params.userId } });

        if (priorSessionCount === 0) {
            this.logger.debug("Skipping platform_login for signup-flow session", { userId: params.userId });
            return;
        }

        const now = new Date().toISOString();

        this.logger.info("Emitting platform_login", {
            userId: params.userId,
            organizationId: params.organizationId,
            priorSessionCount,
        });

        this.analytics.capture(params.userId, "platform_login", {
            user_id: params.userId,
            email: params.email,
            organization_id: params.organizationId,
            provider: params.provider,
            $set: {
                email: params.email,
                name: params.name,
                organization_id: params.organizationId,
                last_login_at: now,
            },
        });
    }
}
