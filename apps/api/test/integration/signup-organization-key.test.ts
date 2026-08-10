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
 * A new auto-join key is only minted on a provider's assertion.
 *
 * Before this, "not on our list of consumer providers" was enough to make a domain an auto-join key,
 * so a provider nobody had added pooled strangers into one organization as its owners. The list cannot
 * be completed, so the default is inverted: without proof, colleagues get separate organizations and
 * invite each other. Splitting colleagues is recoverable; pooling strangers is not.
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

        test("a vouched domain does become an auto-join key, and the next signup joins it", async ({ harness }) => {
            const domain = `vouched-${randomBytes(4).toString("hex")}.example`;
            const vouched: SignupDomainAssertion = { provider: "google", managedDomain: domain };

            const first = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "First", vouched);
            // The second arrives with no assertion at all - e.g. signs in with GitHub. The key already
            // exists, so they still land with their colleague.
            const second = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Second", undefined);

            expect(second.organizationId).toBe(first.organizationId);
            expect(await harness.db.member.count({ where: { organizationId: first.organizationId } })).toBe(2);
        });

        test("an organization that already holds the domain is still joined - grandfathering", async ({ harness }) => {
            // 516 organizations were keyed on a bare domain before this rule existed. Breaking their
            // teams to close a hole they are not part of would be a poor trade.
            const domain = `legacy-${randomBytes(4).toString("hex")}.example`;
            const legacy = await harness.db.organization.create({
                data: { name: "Legacy", slug: `legacy-${randomBytes(4).toString("hex")}`, domain },
            });

            const joiner = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Joiner", undefined);

            expect(joiner.organizationId).toBe(legacy.id);
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

        test("the key resolver reports what it chose and why", async ({ harness }) => {
            const domain = `resolver-${randomBytes(4).toString("hex")}.example`;
            const email = `${uniqueLocalPart()}@${domain}`;

            expect(await resolveSignupOrganizationKey(harness.db, { email, domain, assertedCompany: true })).toEqual({
                key: domain,
                autoJoin: true,
            });
            expect(await resolveSignupOrganizationKey(harness.db, { email, domain, assertedCompany: false })).toEqual({
                key: email,
                autoJoin: false,
            });
            // No assertion, nothing holds the domain -> the address.
            expect(await resolveSignupOrganizationKey(harness.db, { email, domain })).toEqual({
                key: email,
                autoJoin: false,
            });
            // A known provider short-circuits before the lookup.
            expect(
                await resolveSignupOrganizationKey(harness.db, { email: "a@gmail.com", domain: "gmail.com" }),
            ).toEqual({ key: "a@gmail.com", autoJoin: false });
        });
    },
});
