import { integrationTestSuite } from "@autonoma/integration-test";
import { expect, vi } from "vitest";
import type { ResendOnboardingService } from "../../src/signup-hooks/resend.service";
import { SignupHooks } from "../../src/signup-hooks/signup-hooks";
import { OnboardingTestHarness } from "../onboarding/onboarding-harness";

function createTestSignupHooks() {
    const hooks = new SignupHooks({
        resendApiKey: "re_test",
        resendAudienceId: "aud_test",
        resendFromEmail: "test@autonoma.app",
        calLink: "https://cal.com/test",
        discordInviteUrl: "https://discord.gg/test",
    });

    const resend = (hooks as unknown as { resend: ResendOnboardingService }).resend;
    const addToNewsletterSpy = vi.spyOn(resend, "addToNewsletterAudience").mockResolvedValue(undefined);
    const sendWelcomeEmailSpy = vi.spyOn(resend, "sendWelcomeEmail").mockResolvedValue(undefined);

    return { hooks, addToNewsletterSpy, sendWelcomeEmailSpy };
}

async function createUser(harness: OnboardingTestHarness) {
    const ts = Date.now();
    const orgId = await harness.createOrg();
    const user = await harness.db.user.create({
        data: { name: "Test User", email: `test-${ts}-${Math.random()}@example.com` },
    });
    return { orgId, user };
}

function makeParams(db: unknown, userId: string, email: string, orgId: string) {
    return {
        db: db as never,
        userId,
        email,
        name: "Test User",
        organizationId: orgId,
        orgName: "Test Org",
        orgSlug: "test-org",
    };
}

integrationTestSuite({
    name: "SignupHooks - race condition fix",
    createHarness: () => OnboardingTestHarness.create(),
    seed: async () => ({}),
    cases: (test) => {
        test("onUserCreated sends newsletter + default welcome email for free user", async ({ harness }) => {
            const { orgId, user } = await createUser(harness);
            const { hooks, addToNewsletterSpy, sendWelcomeEmailSpy } = createTestSignupHooks();

            await hooks.onUserCreated(makeParams(harness.db, user.id, user.email, orgId));

            expect(addToNewsletterSpy).toHaveBeenCalledOnce();
            expect(sendWelcomeEmailSpy).toHaveBeenCalledOnce();

            const state = await harness.db.signupHookState.findUnique({
                where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
            });
            expect(state?.newsletterAddedAt).not.toBeNull();
            expect(state?.defaultWelcomeEmailSentAt).not.toBeNull();
            expect(state?.premiumWelcomeEmailSentAt).toBeNull();
        });

        test("onUserCreated is idempotent - second call is a no-op", async ({ harness }) => {
            const { orgId, user } = await createUser(harness);
            const { hooks, addToNewsletterSpy, sendWelcomeEmailSpy } = createTestSignupHooks();
            const params = makeParams(harness.db, user.id, user.email, orgId);

            await hooks.onUserCreated(params);
            addToNewsletterSpy.mockClear();
            sendWelcomeEmailSpy.mockClear();

            await hooks.onUserCreated(params);

            expect(addToNewsletterSpy).not.toHaveBeenCalled();
            expect(sendWelcomeEmailSpy).not.toHaveBeenCalled();
        });

        test("onUserAuthenticated catches up on missed newsletter + welcome email", async ({ harness }) => {
            const { orgId, user } = await createUser(harness);
            const { hooks, addToNewsletterSpy, sendWelcomeEmailSpy } = createTestSignupHooks();

            await hooks.onUserAuthenticated(makeParams(harness.db, user.id, user.email, orgId));

            expect(addToNewsletterSpy).toHaveBeenCalledOnce();
            expect(sendWelcomeEmailSpy).toHaveBeenCalledOnce();

            const state = await harness.db.signupHookState.findUnique({
                where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
            });
            expect(state?.newsletterAddedAt).not.toBeNull();
            expect(state?.defaultWelcomeEmailSentAt).not.toBeNull();
        });

        test("onUserAuthenticated is idempotent after onUserCreated already ran", async ({ harness }) => {
            const { orgId, user } = await createUser(harness);
            const { hooks, addToNewsletterSpy, sendWelcomeEmailSpy } = createTestSignupHooks();
            const params = makeParams(harness.db, user.id, user.email, orgId);

            await hooks.onUserCreated(params);
            addToNewsletterSpy.mockClear();
            sendWelcomeEmailSpy.mockClear();

            await hooks.onUserAuthenticated(params);

            expect(addToNewsletterSpy).not.toHaveBeenCalled();
            expect(sendWelcomeEmailSpy).not.toHaveBeenCalled();
        });

        test("race simulation: both hooks fire concurrently, each job runs exactly once", async ({ harness }) => {
            const { orgId, user } = await createUser(harness);
            const { hooks, addToNewsletterSpy, sendWelcomeEmailSpy } = createTestSignupHooks();
            const params = makeParams(harness.db, user.id, user.email, orgId);

            await Promise.all([hooks.onUserCreated(params), hooks.onUserAuthenticated(params)]);

            // Atomic claims ensure each external call happens exactly once
            expect(addToNewsletterSpy).toHaveBeenCalledOnce();
            expect(sendWelcomeEmailSpy).toHaveBeenCalledOnce();

            const state = await harness.db.signupHookState.findUnique({
                where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
            });
            expect(state?.newsletterAddedAt).not.toBeNull();
            expect(state?.defaultWelcomeEmailSentAt).not.toBeNull();
        });

        test("failed hook is unclaimed and retried on next call", async ({ harness }) => {
            const { orgId, user } = await createUser(harness);
            const { hooks, addToNewsletterSpy, sendWelcomeEmailSpy } = createTestSignupHooks();
            const params = makeParams(harness.db, user.id, user.email, orgId);

            // First call: newsletter succeeds, welcome email fails
            sendWelcomeEmailSpy.mockRejectedValueOnce(new Error("Resend API down"));

            await hooks.onUserCreated(params);

            // Newsletter claimed and done, welcome email unclaimed after failure
            const stateAfterFailure = await harness.db.signupHookState.findUnique({
                where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
            });
            expect(stateAfterFailure?.newsletterAddedAt).not.toBeNull();
            expect(stateAfterFailure?.defaultWelcomeEmailSentAt).toBeNull();

            // Second call: welcome email succeeds this time
            addToNewsletterSpy.mockClear();
            sendWelcomeEmailSpy.mockClear();

            await hooks.onUserAuthenticated(params);

            expect(addToNewsletterSpy).not.toHaveBeenCalled();
            expect(sendWelcomeEmailSpy).toHaveBeenCalledOnce();

            const stateAfterRetry = await harness.db.signupHookState.findUnique({
                where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
            });
            expect(stateAfterRetry?.defaultWelcomeEmailSentAt).not.toBeNull();
        });

        test("onUserAuthenticated sends premium welcome email for premium user", async ({ harness }) => {
            const { orgId, user } = await createUser(harness);
            await harness.db.billingCustomer.create({
                data: {
                    organizationId: orgId,
                    stripeCustomerId: `cus_test_${Date.now()}`,
                    subscriptionStatus: "active",
                },
            });

            const { hooks, addToNewsletterSpy, sendWelcomeEmailSpy } = createTestSignupHooks();
            vi.spyOn(hooks as never, "setupCommunicationChannel" as never).mockResolvedValue({
                type: "slack",
            } as never);

            await hooks.onUserAuthenticated(makeParams(harness.db, user.id, user.email, orgId));

            expect(addToNewsletterSpy).toHaveBeenCalledOnce();
            expect(sendWelcomeEmailSpy).toHaveBeenCalledOnce();

            const state = await harness.db.signupHookState.findUnique({
                where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
            });
            expect(state?.newsletterAddedAt).not.toBeNull();
            expect(state?.premiumWelcomeEmailSentAt).not.toBeNull();
            expect(state?.defaultWelcomeEmailSentAt).toBeNull();
        });
    },
});
