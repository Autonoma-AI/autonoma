import { randomBytes } from "node:crypto";
import { PostHogAnalytics } from "@autonoma/analytics";
import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { PlatformEventEmitter } from "../../src/posthog/emit-platform-events";
import { OnboardingTestHarness } from "../onboarding/onboarding-harness";

interface CapturedEvent {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
}

/**
 * Minimal stand-in for `PostHogAnalytics` that records every `capture(...)` call.
 * We extend the real class and override `capture` so the emitter stays strongly typed.
 */
class RecordingAnalytics extends PostHogAnalytics {
    public captures: CapturedEvent[] = [];

    override capture(distinctId: string, event: string, properties?: Record<string, unknown>): void {
        this.captures.push({ distinctId, event, properties });
    }
}

async function createFreshUser(harness: OnboardingTestHarness) {
    const suffix = randomBytes(4).toString("hex");
    const org = await harness.db.organization.create({
        data: { name: `Test Org ${suffix}`, slug: `test-org-${suffix}` },
    });
    const user = await harness.db.user.create({
        data: {
            name: "Test User",
            email: `test-${suffix}@example.com`,
            emailVerified: true,
        },
    });
    await harness.db.member.create({
        data: { userId: user.id, organizationId: org.id, role: "owner" },
    });
    return { orgId: org.id, user };
}

async function insertSession(harness: OnboardingTestHarness, userId: string, orgId: string) {
    return await harness.db.session.create({
        data: {
            token: `session-${randomBytes(8).toString("hex")}`,
            expiresAt: new Date(Date.now() + 86_400_000),
            userId,
            activeOrganizationId: orgId,
        },
    });
}

integrationTestSuite({
    name: "PlatformEventEmitter",
    createHarness: () => OnboardingTestHarness.create(),
    cases: (test) => {
        test("signup flow: onUserCreated emits platform_signup and first session does not emit platform_login", async ({
            harness,
        }) => {
            const { orgId, user } = await createFreshUser(harness);
            const analytics = new RecordingAnalytics();
            const emitter = new PlatformEventEmitter(harness.db, analytics);

            emitter.onUserCreated({
                userId: user.id,
                email: user.email,
                name: user.name,
                organizationId: orgId,
                provider: "google",
            });
            await emitter.onSessionCreated({
                userId: user.id,
                email: user.email,
                name: user.name,
                organizationId: orgId,
                provider: "google",
            });

            const signupEvents = analytics.captures.filter((c) => c.event === "platform_signup");
            const loginEvents = analytics.captures.filter((c) => c.event === "platform_login");

            expect(signupEvents).toHaveLength(1);
            expect(loginEvents).toHaveLength(0);

            const signup = signupEvents[0]!;
            expect(signup.distinctId).toBe(user.id);
            expect(signup.properties).toMatchObject({
                user_id: user.id,
                email: user.email,
                organization_id: orgId,
                provider: "google",
            });
            expect(signup.properties?.$set).toMatchObject({
                email: user.email,
                name: user.name,
                organization_id: orgId,
            });
            expect((signup.properties?.$set as Record<string, unknown>).last_login_at).toBeTypeOf("string");
            expect(signup.properties?.$set_once).toMatchObject({});
            expect((signup.properties?.$set_once as Record<string, unknown>).signup_at).toBeTypeOf("string");
        });

        test("second session emits exactly one platform_login, no additional signup", async ({ harness }) => {
            const { orgId, user } = await createFreshUser(harness);
            const analytics = new RecordingAnalytics();
            const emitter = new PlatformEventEmitter(harness.db, analytics);

            // Simulate the signup session: before-hook runs (count=0, skip login), then the session row is written.
            emitter.onUserCreated({
                userId: user.id,
                email: user.email,
                name: user.name,
                organizationId: orgId,
                provider: "google",
            });
            await emitter.onSessionCreated({
                userId: user.id,
                email: user.email,
                name: user.name,
                organizationId: orgId,
                provider: "google",
            });
            await insertSession(harness, user.id, orgId);

            analytics.captures = [];

            // Simulate a second session creation: before-hook sees count=1, emits platform_login.
            await emitter.onSessionCreated({
                userId: user.id,
                email: user.email,
                name: user.name,
                organizationId: orgId,
                provider: "google",
            });
            await insertSession(harness, user.id, orgId);

            const signupEvents = analytics.captures.filter((c) => c.event === "platform_signup");
            const loginEvents = analytics.captures.filter((c) => c.event === "platform_login");

            expect(signupEvents).toHaveLength(0);
            expect(loginEvents).toHaveLength(1);

            const login = loginEvents[0]!;
            expect(login.distinctId).toBe(user.id);
            expect(login.properties).toMatchObject({
                user_id: user.id,
                email: user.email,
                organization_id: orgId,
                provider: "google",
            });
            expect(login.properties?.$set).toMatchObject({
                email: user.email,
                name: user.name,
                organization_id: orgId,
            });
        });

        test("third session emits one more platform_login", async ({ harness }) => {
            const { orgId, user } = await createFreshUser(harness);
            const analytics = new RecordingAnalytics();
            const emitter = new PlatformEventEmitter(harness.db, analytics);

            // Signup session (no login).
            await emitter.onSessionCreated({
                userId: user.id,
                email: user.email,
                name: user.name,
                organizationId: orgId,
                provider: "google",
            });
            await insertSession(harness, user.id, orgId);

            // Second session -> login.
            await emitter.onSessionCreated({
                userId: user.id,
                email: user.email,
                name: user.name,
                organizationId: orgId,
                provider: "google",
            });
            await insertSession(harness, user.id, orgId);

            analytics.captures = [];

            // Third session -> another login.
            await emitter.onSessionCreated({
                userId: user.id,
                email: user.email,
                name: user.name,
                organizationId: orgId,
                provider: "google",
            });
            await insertSession(harness, user.id, orgId);

            const loginEvents = analytics.captures.filter((c) => c.event === "platform_login");
            expect(loginEvents).toHaveLength(1);
            expect(loginEvents[0]?.distinctId).toBe(user.id);
        });

        test("attribution cookies land on platform_signup event and person properties", async ({ harness }) => {
            const { orgId, user } = await createFreshUser(harness);
            const analytics = new RecordingAnalytics();
            const emitter = new PlatformEventEmitter(harness.db, analytics);

            emitter.onUserCreated({
                userId: user.id,
                email: user.email,
                name: user.name,
                organizationId: orgId,
                provider: "google",
                cookieHeader: "autonoma_referring_blog=qa-bottleneck; autonoma_hypothesis=testing-adoption",
            });

            const signupEvents = analytics.captures.filter((c) => c.event === "platform_signup");
            expect(signupEvents).toHaveLength(1);

            const signup = signupEvents[0]!;
            expect(signup.properties).toMatchObject({
                referring_blog: "qa-bottleneck",
                hypothesis: "testing-adoption",
            });
            expect(signup.properties?.$set_once).toMatchObject({
                signup_referring_blog: "qa-bottleneck",
                signup_hypothesis: "testing-adoption",
            });
        });

        test("missing attribution cookies do not add properties to platform_signup", async ({ harness }) => {
            const { orgId, user } = await createFreshUser(harness);
            const analytics = new RecordingAnalytics();
            const emitter = new PlatformEventEmitter(harness.db, analytics);

            emitter.onUserCreated({
                userId: user.id,
                email: user.email,
                name: user.name,
                organizationId: orgId,
                provider: "google",
                cookieHeader: "unrelated=value; another=thing",
            });

            const signup = analytics.captures[0]!;
            expect(signup.properties).not.toHaveProperty("referring_blog");
            expect(signup.properties).not.toHaveProperty("hypothesis");
            expect(signup.properties?.$set_once).not.toHaveProperty("signup_referring_blog");
            expect(signup.properties?.$set_once).not.toHaveProperty("signup_hypothesis");
        });

        test("cookie values are URL-decoded", async ({ harness }) => {
            const { orgId, user } = await createFreshUser(harness);
            const analytics = new RecordingAnalytics();
            const emitter = new PlatformEventEmitter(harness.db, analytics);

            emitter.onUserCreated({
                userId: user.id,
                email: user.email,
                name: user.name,
                organizationId: orgId,
                provider: "google",
                cookieHeader: "autonoma_referring_blog=how%20we%20ship; autonoma_hypothesis=faster%2Fbetter",
            });

            const signup = analytics.captures[0]!;
            expect(signup.properties).toMatchObject({
                referring_blog: "how we ship",
                hypothesis: "faster/better",
            });
        });
    },
});
