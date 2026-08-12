import { randomBytes } from "node:crypto";
import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

/**
 * The onboarding reads take an `applicationId` and are reached with a session or an
 * API key, so authentication alone never separated two organizations: an id was
 * enough to read another org's onboarding state, its agent activity, and its
 * agent-session view.
 *
 * The second organization here is one the SAME user belongs to, which is the case a
 * membership check alone waves through: what has to hold is the session's ACTIVE
 * organization, not "an org this user is in somewhere".
 */
apiTestSuite({
    name: "onboarding reads are scoped to the caller's organization",
    seed: async ({ harness }) => {
        await harness.db.member.create({
            data: { userId: harness.userId, organizationId: harness.organizationId, role: "owner" },
        });
        const ownApp = await harness.db.application.create({
            data: {
                name: "Own Org App",
                slug: `own-org-app-${randomBytes(4).toString("hex")}`,
                architecture: ApplicationArchitecture.WEB,
                organizationId: harness.organizationId,
            },
        });

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

        return { ownAppId: ownApp.id, otherAppId: otherApp.id };
    },
    cases: (test) => {
        test("getState returns state for an app in the caller's organization", async ({ harness, seedResult }) => {
            const state = await harness.request().onboarding.getState({ applicationId: seedResult.ownAppId });

            expect(state.applicationId).toBe(seedResult.ownAppId);
        });

        test("getState refuses an app in another organization", async ({ harness, seedResult }) => {
            await expect(
                harness.request().onboarding.getState({ applicationId: seedResult.otherAppId }),
            ).rejects.toThrow(/Application not found/);
        });

        // Neither read writes at all now, so this pins the property from the other side: a refused
        // call must leave no trace in someone else's organization.
        test("a refused getState writes nothing into the foreign app", async ({ harness, seedResult }) => {
            await expect(
                harness.request().onboarding.getState({ applicationId: seedResult.otherAppId }),
            ).rejects.toThrow();

            const row = await harness.db.onboardingState.findUnique({
                where: { applicationId: seedResult.otherAppId },
            });
            expect(row).toBeNull();
        });

        test("navState returns the gate for an app in the caller's organization", async ({ harness, seedResult }) => {
            const navState = await harness.request().onboarding.navState({ applicationId: seedResult.ownAppId });

            expect(navState.setupComplete).toBe(false);
        });

        test("navState refuses an app in another organization", async ({ harness, seedResult }) => {
            await expect(
                harness.request().onboarding.navState({ applicationId: seedResult.otherAppId }),
            ).rejects.toThrow(/Application not found/);
        });

        test("getLogs refuses an app in another organization", async ({ harness, seedResult }) => {
            await expect(
                harness.request().onboarding.getLogs({ applicationId: seedResult.otherAppId }),
            ).rejects.toThrow(/Application not found/);
        });

        test("getAgentSession refuses an app in another organization", async ({ harness, seedResult }) => {
            await expect(
                harness.request().onboarding.getAgentSession({ applicationId: seedResult.otherAppId }),
            ).rejects.toThrow(/Application not found/);
        });

        // A missing app and a foreign app must be indistinguishable, or the endpoint
        // becomes an oracle for which application ids exist.
        test("an unknown application id fails the same way a foreign one does", async ({ harness }) => {
            await expect(
                harness.request().onboarding.getState({ applicationId: "app_does_not_exist" }),
            ).rejects.toThrow(/Application not found/);
        });
    },
});
