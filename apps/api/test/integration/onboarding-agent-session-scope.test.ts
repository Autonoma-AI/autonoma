import { randomBytes } from "node:crypto";
import { ApplicationArchitecture } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { expect } from "vitest";
import { resolveMcpPrincipal } from "../../src/mcp/mcp-principal";
import { resolveMcpTarget } from "../../src/mcp/resolve-mcp-target";
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
    name: "MCP target resolution and org scoping",
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

        test("resolveMcpTarget allows an app inside the credential's organization", async ({ harness, seedResult }) => {
            const principal = await resolveMcpPrincipal(harness.db, {
                userId: harness.userId,
                organizationId: seedResult.otherOrgId,
            });

            const target = await resolveMcpTarget(
                { db: harness.db, listRepositories: () => Promise.resolve([]) },
                principal,
                { applicationId: seedResult.otherAppId },
            );

            expect(target.organizationId).toBe(seedResult.otherOrgId);
            expect(target.applicationId).toBe(seedResult.otherAppId);
        });

        test("resolveMcpTarget refuses an app outside the credential's organization", async ({
            harness,
            seedResult,
        }) => {
            const principal = await resolveMcpPrincipal(harness.db, {
                userId: harness.userId,
                organizationId: harness.organizationId,
            });

            // The user IS a member of the app's org, so only the key's scope can reject this.
            await expect(
                resolveMcpTarget({ db: harness.db, listRepositories: () => Promise.resolve([]) }, principal, {
                    applicationId: seedResult.otherAppId,
                }),
            ).rejects.toThrow(NotFoundError);
        });

        test("both identity forms resolve to the same application", async ({ harness }) => {
            // The whole point of the shared resolver: an agent mid-onboarding has an
            // applicationId from a pairing code, an agent in a checkout has a remote. Seven
            // tool names differed across the two servers on this field alone.
            const repoFullName = "acme/both-forms";
            const githubRepositoryId = 90901;
            const app = await harness.db.application.create({
                data: {
                    name: "Both Forms App",
                    slug: `both-forms-${randomBytes(4).toString("hex")}`,
                    architecture: ApplicationArchitecture.WEB,
                    organizationId: harness.organizationId,
                    githubRepositoryId,
                },
            });
            const listed = [
                {
                    id: githubRepositoryId,
                    name: "both-forms",
                    fullName: repoFullName,
                    defaultBranch: "main",
                    private: true,
                    applicationId: app.id,
                    applicationName: app.name,
                },
            ];
            const principal = await resolveMcpPrincipal(harness.db, { userId: harness.userId });
            // Per-org, like the real listRepositories. A stub that returns the same repo for
            // every org makes it look linked in two of them, and resolution refuses to
            // disambiguate rather than picking one - so the assertion below never runs.
            const deps = {
                db: harness.db,
                listRepositories: (orgId: string) => Promise.resolve(orgId === harness.organizationId ? listed : []),
            };

            const byId = await resolveMcpTarget(deps, principal, { applicationId: app.id });
            const byRepo = await resolveMcpTarget(deps, principal, { repoFullName });

            expect(byRepo).toEqual(byId);
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
