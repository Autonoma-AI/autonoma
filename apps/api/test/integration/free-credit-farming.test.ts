import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";
import { expect } from "vitest";
import { ensureOrgMembership } from "../../src/auth";
import { apiTestSuite } from "../api-test";

/**
 * The free starting credits are granted per ORGANIZATION and spendable by its members, so anything that
 * lets one account bring new organizations into existence mints currency. These tests hold that shut.
 *
 * What they are guarding against, which was once live: three facts combined into a loop.
 *
 * 1. `organization()` was configured with no options, and better-auth's
 *    `allowUserToCreateOrganization` resolves to true when unset, so `POST /organization/create` was
 *    open to any signed-in user - and it was not in `DISABLED_ORGANIZATION_PATHS` either.
 * 2. `organization.setActive` persists the choice to `user.lastOrganizationId`.
 * 3. `session.create.before` runs on EVERY sign-in and calls `ensureOrgMembership`, which calls
 *    `ensureBillingProvisioning` on whatever `lastOrganizationId` names - and that funded any
 *    organization with no billing customer yet.
 *
 * Create an organization, make it active, sign in again, collect the full starting balance, repeat -
 * one account, one email, no invitation and no second identity.
 *
 * Both halves are closed now: the endpoints are refused, and the grant is opt-in per call site. This
 * file covers the second half, which is the one a future change could undo without noticing - handed an
 * organization it did not create, a sign-in must not fund it. The last case guards the other
 * direction, so "grant nothing, ever" cannot pass for a fix.
 */
apiTestSuite({
    name: "free-credit-farming",
    cases: (test) => {
        /** Exactly what better-auth's `/organization/create` writes: the org, and its creator as owner. */
        async function createOrganizationAsPluginWould(db: PrismaClient, userId: string) {
            const organization = await db.organization.create({
                data: {
                    name: `Farmed ${randomBytes(3).toString("hex")}`,
                    slug: `farmed-${randomBytes(4).toString("hex")}`,
                },
            });
            await db.member.create({ data: { userId, organizationId: organization.id, role: "owner" } });
            return organization;
        }

        test("a self-created organization is NOT funded by the next sign-in", async ({ harness }) => {
            const user = await harness.db.user.findUniqueOrThrow({ where: { id: harness.userId } });
            const grantCount = async () => {
                const memberships = await harness.db.member.findMany({
                    where: { userId: user.id },
                    select: { organizationId: true },
                });
                return harness.db.creditTransaction.count({
                    where: {
                        type: "FREE_START_GRANT",
                        organizationId: { in: memberships.map((row) => row.organizationId) },
                    },
                });
            };
            const grantsBefore = await grantCount();

            const farmed = await createOrganizationAsPluginWould(harness.db, harness.userId);
            // No grant yet - creation alone mints nothing.
            expect(await harness.db.billingCustomer.findUnique({ where: { organizationId: farmed.id } })).toBeNull();

            // `organization.setActive` persists this, which is the only state the loop needs.
            await harness.db.user.update({ where: { id: user.id }, data: { lastOrganizationId: farmed.id } });

            // What `session.create.before` does on the next sign-in.
            await ensureOrgMembership(harness.db, user.id, user.email, user.name);

            const customer = await harness.db.billingCustomer.findUnique({
                where: { organizationId: farmed.id },
                select: { creditBalance: true },
            });
            const pricing = await harness.db.billingPricing.findUnique({
                where: { organizationId: farmed.id },
                select: { creditsFreeStart: true },
            });

            // Provisioned so the credits gate has a row to read, but with nothing in it.
            expect(customer).not.toBeNull();
            expect(customer?.creditBalance).toBe(0);
            expect(pricing?.creditsFreeStart).toBeGreaterThan(0);

            // And no ledger entry claiming a grant that did not happen.
            expect(await grantCount()).toBe(grantsBefore);
        });

        test("repeating the loop adds no credits at all", async ({ harness }) => {
            const user = await harness.db.user.findUniqueOrThrow({ where: { id: harness.userId } });
            const balanceOf = async () => {
                const memberships = await harness.db.member.findMany({
                    where: { userId: user.id },
                    select: { organizationId: true },
                });
                const rows = await harness.db.billingCustomer.findMany({
                    where: { organizationId: { in: memberships.map((row) => row.organizationId) } },
                    select: { creditBalance: true },
                });
                return rows.reduce((total: number, row: { creditBalance: number }) => total + row.creditBalance, 0);
            };

            const before = await balanceOf();
            for (let round = 0; round < 3; round++) {
                const farmed = await createOrganizationAsPluginWould(harness.db, harness.userId);
                await harness.db.user.update({ where: { id: user.id }, data: { lastOrganizationId: farmed.id } });
                await ensureOrgMembership(harness.db, user.id, user.email, user.name);
            }
            const after = await balanceOf();

            expect(after).toBe(before);
        });
    },
});

/**
 * The other half of the same invariant: closing the mint must not have closed the legitimate grant.
 */
apiTestSuite({
    name: "free-credit-grant-on-signup",
    cases: (test) => {
        test("a real signup still gets its starting credits", async ({ harness }) => {
            const email = `fresh-${randomBytes(5).toString("hex")}@gmail.com`;
            const user = await harness.db.user.create({ data: { name: "Fresh Signup", email, emailVerified: true } });

            const { organizationId } = await ensureOrgMembership(harness.db, user.id, email, "Fresh Signup");

            const [customer, pricing] = await Promise.all([
                harness.db.billingCustomer.findUnique({
                    where: { organizationId },
                    select: { creditBalance: true },
                }),
                harness.db.billingPricing.findUnique({
                    where: { organizationId },
                    select: { creditsFreeStart: true },
                }),
            ]);

            expect(pricing?.creditsFreeStart).toBeGreaterThan(0);
            expect(customer?.creditBalance).toBe(pricing?.creditsFreeStart);
            expect(
                await harness.db.creditTransaction.count({
                    where: { organizationId, type: "FREE_START_GRANT" },
                }),
            ).toBe(1);
        });
    },
});
