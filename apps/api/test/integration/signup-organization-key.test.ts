import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";
import { expect } from "vitest";
import { ensureOrgMembership } from "../../src/auth";
import { resolveSignupOrganizationKey } from "../../src/resolve-signup-organization-key";
import type { SignupDomainAssertion } from "../../src/signup-domain-assertion";
import { apiTestSuite } from "../api-test";

function uniqueLocalPart(): string {
    return `probe-${randomBytes(5).toString("hex")}`;
}

async function signUp(db: PrismaClient, email: string, name: string, assertion?: SignupDomainAssertion) {
    const user = await db.user.create({ data: { name, email, emailVerified: true } });
    return ensureOrgMembership(db, user.id, email, name, assertion);
}

/**
 * An organization is keyed on a bare domain only when the provider vouched for that domain.
 *
 * Two weaker rules used to stand in for that proof: "not on our list of consumer providers", and
 * "some organization already holds this domain". Both pooled strangers into one organization as its
 * owners - the first because the list cannot be completed, the second because it kept honouring keys
 * the first had minted. Without proof, colleagues now get separate organizations and invite each
 * other. Splitting colleagues is recoverable; pooling strangers is not.
 */
apiTestSuite({
    name: "signup-organization-key",
    cases: (test) => {
        test("an unvouched company-looking domain does NOT become an auto-join key", async ({ harness }) => {
            const domain = `unvouched-${randomBytes(4).toString("hex")}.example`;

            const first = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "First", undefined);
            const second = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Second", undefined);

            // The cost of the new default, and the point of it: they are separate until one invites.
            expect(second.organizationId).not.toBe(first.organizationId);
            const keyed = await harness.db.organization.findFirst({ where: { domain }, select: { id: true } });
            expect(keyed).toBeNull();
        });

        test("a vouched domain does become an auto-join key, and the next vouched signup joins it", async ({
            harness,
        }) => {
            const domain = `vouched-${randomBytes(4).toString("hex")}.example`;
            const vouched: SignupDomainAssertion = { provider: "google", managedDomain: domain };

            const first = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "First", vouched);
            const second = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Second", vouched);

            expect(second.organizationId).toBe(first.organizationId);
            expect(await harness.db.member.count({ where: { organizationId: first.organizationId } })).toBe(2);
        });

        test("an organization holding the domain is NOT joined by a signup nobody vouched for", async ({ harness }) => {
            // The rule this replaces: holding the key was itself treated as proof, so a key minted
            // before assertions existed kept pooling whoever arrived at that domain. An existing team
            // is not broken by this - their own provider still vouches for them, and anyone it does not
            // vouch for gets an invitation instead of somebody else's organization.
            const domain = `legacy-${randomBytes(4).toString("hex")}.example`;
            const legacy = await harness.db.organization.create({
                data: { name: "Legacy", slug: `legacy-${randomBytes(4).toString("hex")}`, domain },
            });

            const stranger = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Stranger", undefined);

            expect(stranger.organizationId).not.toBe(legacy.id);
            expect(await harness.db.member.count({ where: { organizationId: legacy.id } })).toBe(0);
        });

        test("a vouched organization is treated as already named; an unvouched one is asked", async ({ harness }) => {
            const vouchedDomain = `named-${randomBytes(4).toString("hex")}.example`;
            const vouched = await signUp(harness.db, `${uniqueLocalPart()}@${vouchedDomain}`, "Vouched Person", {
                provider: "google",
                managedDomain: vouchedDomain,
            });
            const unvouchedDomain = `unnamed-${randomBytes(4).toString("hex")}.example`;
            const unvouched = await signUp(harness.db, `${uniqueLocalPart()}@${unvouchedDomain}`, "Solo Person");

            const [a, b] = await Promise.all([
                harness.db.organization.findUniqueOrThrow({
                    where: { id: vouched.organizationId },
                    select: { name: true, nameConfirmedAt: true },
                }),
                harness.db.organization.findUniqueOrThrow({
                    where: { id: unvouched.organizationId },
                    select: { name: true, nameConfirmedAt: true },
                }),
            ]);

            // A shared organization carries the company's name and needs no confirming.
            expect(a.nameConfirmedAt).not.toBeNull();
            // One person's carries theirs, which is not necessarily whose organization it is.
            expect(b.name).toBe("Solo Person");
            expect(b.nameConfirmedAt).toBeNull();
        });

        test("a provider calling the account personal keeps a corporate-looking domain unkeyed", async ({
            harness,
        }) => {
            const domain = `personal-${randomBytes(4).toString("hex")}.example`;
            const personal: SignupDomainAssertion = { provider: "microsoft" };

            const first = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "One", personal);
            const second = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Two", personal);

            expect(second.organizationId).not.toBe(first.organizationId);
        });

        test("the key resolver keys on the domain only when vouched for", async ({ harness }) => {
            const domain = `resolver-${randomBytes(4).toString("hex")}.example`;
            const email = `${uniqueLocalPart()}@${domain}`;

            expect(resolveSignupOrganizationKey({ email, domain, assertedCompany: true })).toEqual({
                key: domain,
                autoJoin: true,
            });
            // Denied and "asserted nothing" are the same answer: neither is proof.
            expect(resolveSignupOrganizationKey({ email, domain, assertedCompany: false })).toEqual({
                key: email,
                autoJoin: false,
            });
            expect(resolveSignupOrganizationKey({ email, domain })).toEqual({ key: email, autoJoin: false });

            // Deciding this needs no database at all - which is the point. An organization holding the
            // domain cannot influence the key, so there is nothing to read.
            const held = `held-${randomBytes(4).toString("hex")}.example`;
            await harness.db.organization.create({
                data: { name: "Held", slug: `held-${randomBytes(4).toString("hex")}`, domain: held },
            });
            expect(resolveSignupOrganizationKey({ email: `someone@${held}`, domain: held })).toEqual({
                key: `someone@${held}`,
                autoJoin: false,
            });
        });
    },
});
