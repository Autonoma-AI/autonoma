import { randomBytes } from "node:crypto";
import { ApplicationArchitecture } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { expect } from "vitest";
import { resolveMcpPrincipal } from "../../src/mcp/mcp-principal";
import { RateLimiterService } from "../../src/rate-limit/rate-limiter.service";
import { OnboardingAgentSessionService } from "../../src/routes/onboarding/onboarding-agent-session.service";
import { apiTestSuite } from "../api-test";

/**
 * An API key is minted for one organization, so over MCP it must not reach an app in another -
 * not even one its owner is a member of, which is exactly the case a membership check alone waves
 * through. These drive the real `resolveMcpPrincipal` rather than a hand-built principal, so they
 * cover the credential-to-boundary step as well as the enforcement.
 */
apiTestSuite({
    name: "Onboarding agent session org scoping",
    seed: async ({ harness }) => {
        await harness.db.member.create({
            data: { userId: harness.userId, organizationId: harness.organizationId, role: "owner" },
        });
        // A second org the SAME user belongs to. Membership alone cannot separate these two.
        const otherOrg = await harness.db.organization.create({
            data: { name: "Other Org", slug: `other-org-${randomBytes(4).toString("hex")}` },
        });
        await harness.db.member.create({
            data: { userId: harness.userId, organizationId: otherOrg.id, role: "owner" },
        });
        const otherApp = await harness.db.application.create({
            data: {
                name: "Other Org App",
                slug: `other-org-app-${randomBytes(4).toString("hex")}`,
                architecture: ApplicationArchitecture.WEB,
                organizationId: otherOrg.id,
            },
        });
        return { otherOrgId: otherOrg.id, otherAppId: otherApp.id };
    },
    cases: (test) => {
        test("an API key credential resolves to only its own organization", async ({ harness, seedResult }) => {
            const principal = await resolveMcpPrincipal(harness.db, {
                userId: harness.userId,
                organizationId: seedResult.otherOrgId,
            });

            expect(principal.organizationIds).toEqual([seedResult.otherOrgId]);
        });

        test("an OAuth credential resolves to every organization the user belongs to", async ({
            harness,
            seedResult,
        }) => {
            const principal = await resolveMcpPrincipal(harness.db, { userId: harness.userId });

            expect(principal.organizationIds).toHaveLength(2);
            expect(principal.organizationIds).toContain(harness.organizationId);
            expect(principal.organizationIds).toContain(seedResult.otherOrgId);
        });

        test("a key naming an org its owner does not belong to reaches nothing", async ({ harness }) => {
            const strangerOrg = await harness.db.organization.create({
                data: { name: "Stranger Org", slug: `stranger-org-${randomBytes(4).toString("hex")}` },
            });

            const principal = await resolveMcpPrincipal(harness.db, {
                userId: harness.userId,
                organizationId: strangerOrg.id,
            });

            // The scope narrows memberships, it never grants one.
            expect(principal.organizationIds).toEqual([]);
        });

        test("resolveOrgForMember allows an app inside the credential's organization", async ({
            harness,
            seedResult,
        }) => {
            const service = new OnboardingAgentSessionService(harness.db, new RateLimiterService(harness.db));
            const principal = await resolveMcpPrincipal(harness.db, {
                userId: harness.userId,
                organizationId: seedResult.otherOrgId,
            });

            const organizationId = await service.resolveOrgForMember(seedResult.otherAppId, principal);

            expect(organizationId).toBe(seedResult.otherOrgId);
        });

        test("resolveOrgForMember refuses an app outside the credential's organization", async ({
            harness,
            seedResult,
        }) => {
            const service = new OnboardingAgentSessionService(harness.db, new RateLimiterService(harness.db));
            const principal = await resolveMcpPrincipal(harness.db, {
                userId: harness.userId,
                organizationId: harness.organizationId,
            });

            // The user IS a member of the app's org, so only the key's scope can reject this.
            await expect(service.resolveOrgForMember(seedResult.otherAppId, principal)).rejects.toThrow(NotFoundError);
        });

        test("pairAgent refuses a code for an app outside the credential's organization", async ({
            harness,
            seedResult,
        }) => {
            const service = new OnboardingAgentSessionService(harness.db, new RateLimiterService(harness.db));
            const { code } = await service.createPairing(seedResult.otherAppId, seedResult.otherOrgId);
            const principal = await resolveMcpPrincipal(harness.db, {
                userId: harness.userId,
                organizationId: harness.organizationId,
            });

            await expect(service.pairAgent(code, principal)).rejects.toThrow(NotFoundError);

            // The code must survive a rejected attempt, or an out-of-scope caller could burn a
            // valid code the rightful agent is about to use.
            const state = await harness.db.onboardingState.findUnique({
                where: { applicationId: seedResult.otherAppId },
                select: { agentPairingCode: true },
            });
            expect(state?.agentPairingCode).toBe(code);
        });

        test("pairAgent accepts a code for an app inside the credential's organization", async ({
            harness,
            seedResult,
        }) => {
            const service = new OnboardingAgentSessionService(harness.db, new RateLimiterService(harness.db));
            const { code } = await service.createPairing(seedResult.otherAppId, seedResult.otherOrgId);
            const principal = await resolveMcpPrincipal(harness.db, {
                userId: harness.userId,
                organizationId: seedResult.otherOrgId,
            });

            const view = await service.pairAgent(code, principal);

            expect(view.applicationId).toBe(seedResult.otherAppId);
        });
    },
});
