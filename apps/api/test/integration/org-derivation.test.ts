import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";
import { expect } from "vitest";
import { ensureOrgMembership } from "../../src/auth";
import type { SignupDomainAssertion } from "../../src/signup-domain-assertion";
import { apiTestSuite } from "../api-test";

function uniqueLocalPart(): string {
    return `probe-${randomBytes(5).toString("hex")}`;
}

/**
 * Which organization a signup lands in, which is the difference between colleagues sharing a
 * workspace and strangers sharing one.
 *
 * This had no coverage, and it went wrong: the consumer-provider list held only `gmail.com`, so every
 * `@outlook.com` signup auto-joined a single shared organization as its owner, able to see the other
 * members' applications and contact details.
 */
apiTestSuite({
    name: "org-derivation",
    cases: (test) => {
        async function signUpWith(db: PrismaClient, email: string, name: string, assertion?: SignupDomainAssertion) {
            const user = await db.user.create({ data: { name, email, emailVerified: true } });
            return { user, result: await ensureOrgMembership(db, user.id, email, name, assertion) };
        }

        test("two strangers on the same consumer provider get separate organizations", async ({ harness }) => {
            const domain = "outlook.com";
            const first = await signUpWith(harness.db, `${uniqueLocalPart()}@${domain}`, "First Person");
            const second = await signUpWith(harness.db, `${uniqueLocalPart()}@${domain}`, "Second Person");

            expect(first.result.organizationId).not.toBe(second.result.organizationId);

            // And neither can see the other: one member each.
            for (const organizationId of [first.result.organizationId, second.result.organizationId]) {
                const members = await harness.db.member.count({ where: { organizationId } });
                expect(members).toBe(1);
            }
        });

        test("colleagues on a vouched company domain share one organization", async ({ harness }) => {
            // Vouched, because an unvouched domain is no longer an auto-join key - see
            // `signup-organization-key.test.ts`. The provider's assertion is what makes them colleagues
            // rather than two strangers who happen to share a domain suffix.
            const domain = `acme-${randomBytes(4).toString("hex")}.com`;
            const vouched = { provider: "google", managedDomain: domain } as const;
            const first = await signUpWith(harness.db, `${uniqueLocalPart()}@${domain}`, "First Colleague", vouched);
            const second = await signUpWith(harness.db, `${uniqueLocalPart()}@${domain}`, "Second Colleague", vouched);

            expect(second.result.organizationId).toBe(first.result.organizationId);
            const members = await harness.db.member.count({ where: { organizationId: first.result.organizationId } });
            expect(members).toBe(2);
        });

        test("a consumer-provider organization is keyed on the address, so it can be invited into", async ({
            harness,
        }) => {
            const email = `${uniqueLocalPart()}@gmail.com`;
            const { result } = await signUpWith(harness.db, email, "Solo Person");

            const org = await harness.db.organization.findUniqueOrThrow({
                where: { id: result.organizationId },
                select: { domain: true, nameConfirmedAt: true },
            });
            // The "@" is what marks an org nobody can auto-join, which is what makes invites meaningful.
            expect(org.domain).toBe(email);
            // Named after one person, so it must still be asked for a real name.
            expect(org.nameConfirmedAt).toBeNull();
        });

        test("a vouched company-domain organization is treated as already named", async ({ harness }) => {
            const domain = `corp-${randomBytes(4).toString("hex")}.com`;
            const { result } = await signUpWith(harness.db, `${uniqueLocalPart()}@${domain}`, "Corp Person", {
                provider: "google",
                managedDomain: domain,
            });

            const org = await harness.db.organization.findUniqueOrThrow({
                where: { id: result.organizationId },
                select: { domain: true, nameConfirmedAt: true },
            });
            expect(org.domain).toBe(domain);
            expect(org.nameConfirmedAt).not.toBeNull();
        });

        test("a blank email is refused rather than pooling everyone into one organization", async ({ harness }) => {
            const user = await harness.db.user.create({
                data: { name: "No Email", email: `placeholder-${randomBytes(4).toString("hex")}@example.com` },
            });

            await expect(ensureOrgMembership(harness.db, user.id, "   ", "No Email")).rejects.toThrow(/email/i);
        });

        test("two people who share a name each get an organization instead of the second failing", async ({
            harness,
        }) => {
            // Both slugify to the same thing, and `Organization.slug` is unique across the table - so
            // before the slug got a suffix the second of these died on a constraint violation, which
            // for a real signup meant being unable to get in at all.
            const sameName = "Jordan Rivers";
            const first = await signUpWith(harness.db, `${uniqueLocalPart()}@gmail.com`, sameName);
            const second = await signUpWith(harness.db, `${uniqueLocalPart()}@gmail.com`, sameName);

            expect(first.result.organizationId).not.toBe(second.result.organizationId);
            expect(second.result.orgSlug).not.toBe(first.result.orgSlug);
            // The name is what the person sees; only the slug is disambiguated.
            expect(second.result.orgName).toBe(sameName);
        });

        test("a company domain resolves to one organization whatever case it arrives in", async ({ harness }) => {
            // `Organization.domain` is unique and case-sensitive, so a provider that hands back
            // `Acme.com` for one colleague and `acme.com` for the next would split the team in two.
            const domain = `Corp-${randomBytes(4).toString("hex")}.COM`;
            const first = await signUpWith(harness.db, `${uniqueLocalPart()}@${domain}`, "Mixed Case", {
                provider: "google",
                managedDomain: domain,
            });
            const second = await signUpWith(harness.db, `${uniqueLocalPart()}@${domain.toLowerCase()}`, "Lower Case", {
                provider: "google",
                managedDomain: domain.toLowerCase(),
            });

            expect(second.result.organizationId).toBe(first.result.organizationId);

            const org = await harness.db.organization.findUniqueOrThrow({
                where: { id: first.result.organizationId },
                select: { domain: true },
            });
            expect(org.domain).toBe(domain.toLowerCase());
        });

        test("an existing membership is reused rather than deriving a second organization", async ({ harness }) => {
            const email = `${uniqueLocalPart()}@gmail.com`;
            const { user, result } = await signUpWith(harness.db, email, "Repeat Person");

            const again = await ensureOrgMembership(harness.db, user.id, email, "Repeat Person");

            expect(again.organizationId).toBe(result.organizationId);
            expect(again.isNewUser).toBe(false);
            expect(await harness.db.member.count({ where: { userId: user.id } })).toBe(1);
        });
    },
});
