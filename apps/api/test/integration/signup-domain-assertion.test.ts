import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";
import { expect } from "vitest";
import { ensureOrgMembership } from "../../src/auth";
import { type SignupDomainAssertion, assertedCompanyDomain } from "../../src/signup-domain-assertion";
import { apiTestSuite } from "../api-test";

function uniqueLocalPart(): string {
    return `probe-${randomBytes(5).toString("hex")}`;
}

/**
 * Deciding which organization a signup joins from what the identity provider asserts, instead of from
 * a hand-maintained list of consumer providers.
 *
 * Google's `hd` claim is a positive statement that a domain is Workspace-administered. For that
 * provider it is the complete answer, not a hint: signing in as `someone@acme.com` requires acme.com
 * to be a Workspace domain, so `hd` present means a company and `hd` absent means a consumer account.
 * Every other provider asserts nothing and still falls back to the list.
 */
apiTestSuite({
    name: "signup-domain-assertion",
    cases: (test) => {
        test("a Workspace domain the list has never heard of is treated as a company", async ({ harness }) => {
            const domain = `acme-${randomBytes(4).toString("hex")}.example`;
            const assertion = { provider: "google", managedDomain: domain } as const;

            const first = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "First Colleague", assertion);
            const second = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Second Colleague", assertion);

            expect(second.organizationId).toBe(first.organizationId);
            const members = await harness.db.member.count({ where: { organizationId: first.organizationId } });
            expect(members).toBe(2);
        });

        test("a domain Google says it does not administer gets one organization per person", async ({ harness }) => {
            // The list already covers gmail.com, but the assertion is what decides here - and this is
            // the case the list cannot cover in general, because it cannot enumerate every provider.
            const domain = "gmail.com";
            const noManagedDomain = { provider: "google" } as const;

            const first = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "One", noManagedDomain);
            const second = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Two", noManagedDomain);

            expect(second.organizationId).not.toBe(first.organizationId);
        });

        test("an unlisted consumer provider stops pooling strangers once Google denies the domain", async ({
            harness,
        }) => {
            // The exact defect the list keeps re-introducing: a provider nobody added. With the
            // assertion there is nothing to add - Google not naming the domain is the answer.
            const domain = `mailbox-${randomBytes(4).toString("hex")}.example`;
            const noManagedDomain = { provider: "google" } as const;

            const first = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Stranger One", noManagedDomain);
            const second = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Stranger Two", noManagedDomain);

            expect(second.organizationId).not.toBe(first.organizationId);
            for (const organizationId of [first.organizationId, second.organizationId]) {
                expect(await harness.db.member.count({ where: { organizationId } })).toBe(1);
            }
        });

        test("with no assertion nobody is pooled, listed provider or not", async ({ harness }) => {
            // No assertion is what a GitHub or email sign-in looks like. The list still short-circuits a
            // domain it recognises, but it is no longer what keeps strangers apart - an unrecognised
            // domain reaches the same answer by the default, which is what makes the list survivable.
            const listed = `${uniqueLocalPart()}@outlook.com`;
            const first = await signUp(harness.db, listed, "Github One", undefined);
            const second = await signUp(harness.db, `${uniqueLocalPart()}@outlook.com`, "Github Two", undefined);
            expect(second.organizationId).not.toBe(first.organizationId);

            const unlisted = `corp-${randomBytes(4).toString("hex")}.example`;
            const a = await signUp(harness.db, `${uniqueLocalPart()}@${unlisted}`, "Corp One", undefined);
            const b = await signUp(harness.db, `${uniqueLocalPart()}@${unlisted}`, "Corp Two", undefined);
            expect(b.organizationId).not.toBe(a.organizationId);
            // And no auto-join key was minted for it, so a later signup cannot be pooled either.
            expect(await harness.db.organization.findFirst({ where: { domain: unlisted } })).toBeNull();
        });

        test("a Microsoft tenant-verified domain shares one organization", async ({ harness }) => {
            // Reaches ensureOrgMembership identically to Google's - the decision does not care which
            // provider vouched, only that one did.
            const domain = `tenant-${randomBytes(4).toString("hex")}.example`;
            const assertion = { provider: "microsoft", managedDomain: domain } as const;

            const first = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Entra One", assertion);
            const second = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Entra Two", assertion);

            expect(second.organizationId).toBe(first.organizationId);
        });

        test("a personal Microsoft account on a corporate-looking domain gets its own organization", async ({
            harness,
        }) => {
            // The consumer-tenant case, and the one the list can never catch: a personal account can
            // wear its own domain, so the domain tells you nothing.
            const domain = `looks-like-a-company-${randomBytes(4).toString("hex")}.example`;
            const personal = { provider: "microsoft" } as const;

            const first = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "MSA One", personal);
            const second = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "MSA Two", personal);

            expect(second.organizationId).not.toBe(first.organizationId);
        });

        test("a mismatched managed domain is not trusted", async ({ harness }) => {
            // `hd` naming some other domain says nothing about this address's domain, so it must not be
            // read as "company" - that would auto-join on a claim the provider never made.
            const domain = `real-${randomBytes(4).toString("hex")}.example`;
            const assertion = { provider: "google", managedDomain: "unrelated.example" } as const;

            const first = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Odd One", assertion);
            const second = await signUp(harness.db, `${uniqueLocalPart()}@${domain}`, "Odd Two", assertion);

            expect(second.organizationId).not.toBe(first.organizationId);
        });
    },
});

async function signUp(db: PrismaClient, email: string, name: string, assertion?: SignupDomainAssertion) {
    const user = await db.user.create({ data: { name, email, emailVerified: true } });
    return ensureOrgMembership(db, user.id, email, name, assertion);
}

// `assertedCompanyDomain` is the decision itself, so its edges are worth pinning without a database.
apiTestSuite({
    name: "asserted-company-domain",
    cases: (test) => {
        test("undefined when no provider asserted anything, so the caller falls back", () => {
            expect(assertedCompanyDomain(undefined, "acme.com")).toBeUndefined();
        });

        test("false when the provider says the account has no managed domain", () => {
            expect(assertedCompanyDomain({ provider: "google" }, "gmail.com")).toBe(false);
        });

        test("true only when the asserted domain is the address's own, ignoring case", () => {
            expect(assertedCompanyDomain({ provider: "google", managedDomain: "Acme.com" }, "acme.com")).toBe(true);
            expect(assertedCompanyDomain({ provider: "google", managedDomain: "other.com" }, "acme.com")).toBe(false);
        });
    },
});
