import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

/**
 * `AuthService` reads that decide what a session is allowed to see. Neither had coverage, and both had
 * bugs: `getOrgStatus` used an unordered `member.findFirst`, so an account approved in one organization
 * and pending in another was sent to `/pending` or not depending on row order; `needsNaming` decides
 * whether someone is asked to name an organization, and asking twice or never are both wrong.
 */
apiTestSuite({
    name: "auth-active-org",
    cases: (test) => {
        async function makeOrg(db: PrismaClient, overrides: Partial<Prisma.OrganizationCreateInput>) {
            return db.organization.create({
                data: {
                    name: `Org ${randomBytes(3).toString("hex")}`,
                    slug: `org-${randomBytes(4).toString("hex")}`,
                    ...overrides,
                },
            });
        }

        test("getOrgStatus reports the ACTIVE organization, not whichever row comes first", async ({ harness }) => {
            const user = await harness.db.user.create({
                data: { name: "Split", email: `split-${randomBytes(4).toString("hex")}@example.com` },
            });
            const approved = await makeOrg(harness.db, { status: "approved" });
            const pending = await makeOrg(harness.db, { status: "pending" });
            for (const org of [approved, pending]) {
                await harness.db.member.create({ data: { userId: user.id, organizationId: org.id, role: "owner" } });
            }

            // Same user, same memberships - the answer must follow the session's organization.
            expect(await harness.services.auth.getOrgStatus(user.id, approved.id)).toBe("approved");
            expect(await harness.services.auth.getOrgStatus(user.id, pending.id)).toBe("pending");
        });

        test("getOrgStatus is pending for an account with no membership at all", async ({ harness }) => {
            const user = await harness.db.user.create({
                data: { name: "Orphan", email: `orphan-${randomBytes(4).toString("hex")}@example.com` },
            });

            expect(await harness.services.auth.getOrgStatus(user.id)).toBe("pending");
        });

        test("needsNaming is true only for an unconfirmed organization named after one person", async ({ harness }) => {
            const personal = await makeOrg(harness.db, {
                domain: `solo-${randomBytes(4).toString("hex")}@gmail.com`,
                nameConfirmedAt: null,
            });

            const view = await harness.services.auth.getActiveOrg(personal.id, undefined);

            expect(view?.needsNaming).toBe(true);
        });

        test("needsNaming is false once a name has been confirmed", async ({ harness }) => {
            const confirmed = await makeOrg(harness.db, {
                domain: `named-${randomBytes(4).toString("hex")}@gmail.com`,
                nameConfirmedAt: new Date(),
            });

            const view = await harness.services.auth.getActiveOrg(confirmed.id, undefined);

            expect(view?.needsNaming).toBe(false);
        });

        test("needsNaming is false for an organization named after a real email domain", async ({ harness }) => {
            // Derived from the company's own domain, so it already carries the company's name.
            const company = await makeOrg(harness.db, {
                domain: `company-${randomBytes(4).toString("hex")}.com`,
                nameConfirmedAt: null,
            });

            const view = await harness.services.auth.getActiveOrg(company.id, undefined);

            expect(view?.needsNaming).toBe(false);
        });

        test("getActiveOrg returns undefined for an organization that does not exist", async ({ harness }) => {
            expect(await harness.services.auth.getActiveOrg("org_does_not_exist", undefined)).toBeUndefined();
        });
    },
});
