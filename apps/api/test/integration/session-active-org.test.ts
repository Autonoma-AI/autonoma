import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";
import { expect } from "vitest";
import { setSessionActiveOrg } from "../../src/routes/auth/set-session-active-org";
import { apiTestSuite } from "../api-test";

/**
 * Moving a session between organizations, which had no coverage at all - and shipped broken twice.
 *
 * The first version wrote only Redis, so an evicted session silently swallowed every write and
 * organization switching did nothing in production. These tests go through
 * `internalAdapter.createSession`, so the session exists in **both** stores the way a real sign-in
 * leaves it, rather than being hand-written into Postgres where the Redis half never engages.
 */
apiTestSuite({
    name: "session-active-org",
    cases: (test) => {
        async function makeOrg(db: PrismaClient) {
            return db.organization.create({
                data: { name: `Org ${randomBytes(3).toString("hex")}`, slug: `org-${randomBytes(4).toString("hex")}` },
            });
        }

        test("a real session moves in both stores, so the change survives a Redis miss", async ({ harness }) => {
            const user = await harness.db.user.create({
                data: { name: "Mover", email: `mover-${randomBytes(4).toString("hex")}@example.com` },
            });
            const target = await makeOrg(harness.db);
            const authCtx = await harness.auth.$context;
            const session = await authCtx.internalAdapter.createSession(user.id);

            await setSessionActiveOrg(harness.auth, session.token, target.id);

            // The durable copy is what a Redis eviction falls back to, so assert on it directly.
            const durable = await harness.db.session.findFirst({
                where: { token: session.token },
                select: { activeOrganizationId: true },
            });
            expect(durable?.activeOrganizationId).toBe(target.id);

            // And the cache the read path serves from agrees.
            const resolved = await authCtx.internalAdapter.findSession(session.token);
            expect(resolved?.session.activeOrganizationId).toBe(target.id);
        });

        test("the guard leaves a session that is acting as a different organization alone", async ({ harness }) => {
            const user = await harness.db.user.create({
                data: { name: "Untouched", email: `untouched-${randomBytes(4).toString("hex")}@example.com` },
            });
            const [working, lost, fallback] = await Promise.all([
                makeOrg(harness.db),
                makeOrg(harness.db),
                makeOrg(harness.db),
            ]);

            const authCtx = await harness.auth.$context;
            const session = await authCtx.internalAdapter.createSession(user.id);
            await setSessionActiveOrg(harness.auth, session.token, working.id);

            // Losing a membership must move only the sessions aimed at the organization being lost.
            await setSessionActiveOrg(harness.auth, session.token, fallback.id, lost.id);

            const durable = await harness.db.session.findFirst({
                where: { token: session.token },
                select: { activeOrganizationId: true },
            });
            expect(durable?.activeOrganizationId).toBe(working.id);
        });

        test("the guard moves a session that IS acting as the organization being lost", async ({ harness }) => {
            const user = await harness.db.user.create({
                data: { name: "Evicted", email: `evicted-${randomBytes(4).toString("hex")}@example.com` },
            });
            const [lost, fallback] = await Promise.all([makeOrg(harness.db), makeOrg(harness.db)]);

            const authCtx = await harness.auth.$context;
            const session = await authCtx.internalAdapter.createSession(user.id);
            await setSessionActiveOrg(harness.auth, session.token, lost.id);

            await setSessionActiveOrg(harness.auth, session.token, fallback.id, lost.id);

            const durable = await harness.db.session.findFirst({
                where: { token: session.token },
                select: { activeOrganizationId: true },
            });
            expect(durable?.activeOrganizationId).toBe(fallback.id);
        });
    },
});
