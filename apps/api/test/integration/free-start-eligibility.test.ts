import { randomBytes } from "node:crypto";
import {
    claimFreeStartEntitlement,
    ensureBillingProvisioning,
    recordFreeStartIneligibility,
    resolveFreeStartEligibility,
} from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { expect } from "vitest";
import { ensureOrgMembership } from "../../src/auth";
import { apiTestSuite } from "../api-test";

/**
 * The free starting credits sit on an organization, but the entitlement to them belongs to a person.
 *
 * Capping per organization cannot see the two loops that cost money. One account can reach new
 * organizations (a Vercel team install creates one per team), and a team can spread the reaching around -
 * one person takes the grant, invites nine colleagues, and each of them creates a Vercel team for
 * another full balance. Nine people who never personally "received" a grant are still nine grants.
 */
apiTestSuite({
    name: "free-start-eligibility",
    cases: (test) => {
        async function makeUser(db: PrismaClient, label: string) {
            return db.user.create({
                data: {
                    name: label,
                    email: `${label}-${randomBytes(4).toString("hex")}@gmail.com`,
                    emailVerified: true,
                },
            });
        }

        /** An organization holding a starting grant, with `members` in it - what a funded team looks like. */
        async function fundedOrg(db: PrismaClient, members: { id: string }[]) {
            const organization = await db.organization.create({
                data: {
                    name: `Funded ${randomBytes(3).toString("hex")}`,
                    slug: `funded-${randomBytes(4).toString("hex")}`,
                },
            });
            await db.billingCustomer.create({ data: { organizationId: organization.id, creditBalance: 100_000 } });
            await db.creditTransaction.create({
                data: {
                    id: `ctr_free_start_${organization.id}`,
                    organizationId: organization.id,
                    type: "FREE_START_GRANT",
                    amount: 100_000,
                    balanceAfter: 100_000,
                },
            });
            for (const member of members) {
                await db.member.create({ data: { userId: member.id, organizationId: organization.id, role: "owner" } });
            }
            return organization;
        }

        test("an address not on the list is eligible", async ({ harness }) => {
            const user = await makeUser(harness.db, "newcomer");

            expect(await resolveFreeStartEligibility(harness.db, user.email)).toEqual({
                eligible: true,
                blockedBy: [],
            });
        });

        test("an account in an organization that never got a grant is still eligible", async ({ harness }) => {
            const user = await makeUser(harness.db, "unfunded");
            const org = await harness.db.organization.create({
                data: { name: "Unfunded", slug: `unfunded-${randomBytes(4).toString("hex")}` },
            });
            await harness.db.member.create({ data: { userId: user.id, organizationId: org.id, role: "owner" } });

            expect((await resolveFreeStartEligibility(harness.db, user.email)).eligible).toBe(true);
        });

        test("a recorded address is ineligible, and the organization is named for the UI", async ({ harness }) => {
            const user = await makeUser(harness.db, "spent");
            const org = await fundedOrg(harness.db, [user]);
            await recordFreeStartIneligibility(harness.db, user.email, org.id);

            const result = await resolveFreeStartEligibility(harness.db, user.email);
            expect(result.eligible).toBe(false);
            expect(result.blockedBy).toEqual([{ id: org.id, name: org.name }]);
        });

        test("the record survives leaving the organization, which a computed answer would not", async ({ harness }) => {
            // Why this is a list and not a query over memberships: leaving would hand the entitlement back.
            const user = await makeUser(harness.db, "leaver");
            const org = await fundedOrg(harness.db, [user]);
            await recordFreeStartIneligibility(harness.db, user.email, org.id);

            await harness.db.member.deleteMany({ where: { userId: user.id, organizationId: org.id } });

            expect((await resolveFreeStartEligibility(harness.db, user.email)).eligible).toBe(false);
        });

        test("case and whitespace cannot buy a second entitlement", async ({ harness }) => {
            const user = await makeUser(harness.db, "mixedcase");
            const org = await fundedOrg(harness.db, [user]);
            await recordFreeStartIneligibility(harness.db, user.email.toUpperCase(), org.id);

            expect((await resolveFreeStartEligibility(harness.db, `  ${user.email}  `)).eligible).toBe(false);
        });

        test("recording twice appends rather than replacing, and is idempotent", async ({ harness }) => {
            const user = await makeUser(harness.db, "twice");
            const first = await fundedOrg(harness.db, [user]);
            const second = await fundedOrg(harness.db, [user]);

            await recordFreeStartIneligibility(harness.db, user.email, first.id);
            await recordFreeStartIneligibility(harness.db, user.email, second.id);
            await recordFreeStartIneligibility(harness.db, user.email, second.id);

            const result = await resolveFreeStartEligibility(harness.db, user.email);
            expect(result.blockedBy.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
        });

        test("a colleague INVITED into a funded organization is ineligible too", async ({ harness }) => {
            // The loop this rule exists for, and the one a per-receipt cap would miss: the colleague
            // never received a grant themselves, so "have you been granted?" says yes-give-them-one.
            const owner = await makeUser(harness.db, "owner");
            const colleague = await makeUser(harness.db, "colleague");
            const org = await fundedOrg(harness.db, [owner, colleague]);

            // What accepting the invitation records.
            await recordFreeStartIneligibility(harness.db, colleague.email, org.id);

            const result = await resolveFreeStartEligibility(harness.db, colleague.email);
            expect(result.eligible).toBe(false);
            expect(result.blockedBy.map((row) => row.id)).toContain(org.id);
        });

        test("a second organization for a spent account is created with no credits", async ({ harness }) => {
            // Modelled on the Vercel install, which is the only way an account reaches a SECOND
            // organization - `ensureOrgMembership` returns the membership it already has rather than
            // deriving another, so it cannot express this case.
            const user = await makeUser(harness.db, "second-org");
            await fundedOrg(harness.db, [user]);

            const second = await harness.db.organization.create({
                data: { name: "Second team", slug: `second-${randomBytes(4).toString("hex")}` },
            });
            await harness.db.member.create({
                data: { userId: user.id, organizationId: second.id, role: "owner" },
            });

            await recordFreeStartIneligibility(harness.db, user.email, second.id);
            const { eligible } = await resolveFreeStartEligibility(harness.db, user.email);
            expect(eligible).toBe(false);
            await ensureBillingProvisioning(harness.db, second.id, { grantFreeStart: eligible });

            const customer = await harness.db.billingCustomer.findUnique({
                where: { organizationId: second.id },
                select: { creditBalance: true },
            });
            expect(customer?.creditBalance).toBe(0);
            expect(
                await harness.db.creditTransaction.count({
                    where: { organizationId: second.id, type: "FREE_START_GRANT" },
                }),
            ).toBe(0);
        });

        test("only one of two concurrent claims for the same address wins", async ({ harness }) => {
            // The race the claim exists for: read-then-grant let two concurrent sign-ins for one address
            // both see "entitled" and both grant a full balance. An SSO callback is retried by browsers
            // and opened in two tabs, so this is reachable without trying.
            const user = await makeUser(harness.db, "racer");
            const [orgA, orgB] = await Promise.all([
                harness.db.organization.create({
                    data: { name: "Race A", slug: `race-a-${randomBytes(4).toString("hex")}` },
                }),
                harness.db.organization.create({
                    data: { name: "Race B", slug: `race-b-${randomBytes(4).toString("hex")}` },
                }),
            ]);

            const claims = await Promise.all([
                claimFreeStartEntitlement(harness.db, user.email, orgA.id),
                claimFreeStartEntitlement(harness.db, user.email, orgB.id),
            ]);

            expect(claims.filter(Boolean)).toHaveLength(1);
            expect((await resolveFreeStartEligibility(harness.db, user.email)).eligible).toBe(false);
        });

        test("a claim on an address that already spent its entitlement is refused", async ({ harness }) => {
            const user = await makeUser(harness.db, "already-spent");
            const first = await fundedOrg(harness.db, [user]);
            await recordFreeStartIneligibility(harness.db, user.email, first.id);

            const second = await harness.db.organization.create({
                data: { name: "Second", slug: `second-claim-${randomBytes(4).toString("hex")}` },
            });
            expect(await claimFreeStartEntitlement(harness.db, user.email, second.id)).toBe(false);
        });

        test("a staff address is never recorded, so staff keep their own trial", async ({ harness }) => {
            // Staff hold memberships in customer organizations through `admin.switchToOrg`. That is
            // looking at an account, not spending a trial, and marking them would deny them one later.
            const staff = await harness.db.user.create({
                data: {
                    name: "Staff",
                    email: `staff-${randomBytes(4).toString("hex")}@${harness.internalDomain}`,
                    emailVerified: true,
                },
            });
            const customerOrg = await fundedOrg(harness.db, [staff]);

            await recordFreeStartIneligibility(harness.db, staff.email, customerOrg.id, harness.internalDomain);

            expect((await resolveFreeStartEligibility(harness.db, staff.email)).eligible).toBe(true);
        });

        test("a first signup is still funded, so the cap has not swallowed the feature", async ({ harness }) => {
            const email = `first-${randomBytes(5).toString("hex")}@gmail.com`;
            const user = await harness.db.user.create({ data: { name: "First", email, emailVerified: true } });

            const { organizationId } = await ensureOrgMembership(harness.db, user.id, email, "First");

            const [customer, pricing] = await Promise.all([
                harness.db.billingCustomer.findUnique({ where: { organizationId }, select: { creditBalance: true } }),
                harness.db.billingPricing.findUnique({
                    where: { organizationId },
                    select: { creditsFreeStart: true },
                }),
            ]);
            expect(pricing?.creditsFreeStart).toBeGreaterThan(0);
            expect(customer?.creditBalance).toBe(pricing?.creditsFreeStart);
        });
    },
});
