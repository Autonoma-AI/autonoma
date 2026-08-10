import { describe, expect, it } from "vitest";
import { microsoftDomainAssertion } from "../../src/microsoft-domain-assertion";
import { assertedCompanyDomain } from "../../src/signup-domain-assertion";

const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const REAL_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";

describe("microsoftDomainAssertion", () => {
    it("calls a consumer-tenant account personal even on a domain that looks corporate", () => {
        // The case no denylist can catch: a personal Microsoft account wearing its own domain.
        const assertion = microsoftDomainAssertion({
            tid: CONSUMER_TENANT,
            preferred_username: "tom@piaggio.dev",
            email: "tom@piaggio.dev",
        });

        expect(assertion).toEqual({ provider: "microsoft" });
        expect(assertedCompanyDomain(assertion, "piaggio.dev")).toBe(false);
    });

    it("treats a native member of a real tenant as owning the UPN's domain", () => {
        // Entra only issues a UPN on a domain the tenant has verified, so this is ownership proof.
        const assertion = microsoftDomainAssertion({
            tid: REAL_TENANT,
            preferred_username: "bob@acme.com",
            email: "bob@acme.com",
        });

        expect(assertion).toEqual({ provider: "microsoft", managedDomain: "acme.com" });
        expect(assertedCompanyDomain(assertion, "acme.com")).toBe(true);
    });

    it("asserts nothing for a federated guest, whose address belongs to someone else", () => {
        // A B2B guest carries the HOST tenant's tid. Reading that as domain ownership would let a
        // guest at bigcorp.com turn their own consumer domain into an auto-join key.
        expect(
            microsoftDomainAssertion({
                tid: REAL_TENANT,
                idp: "live.com",
                preferred_username: "someone@gmail.com",
                email: "someone@gmail.com",
            }),
        ).toBeUndefined();
    });

    it("asserts nothing when the mail attribute sits on a different domain than the UPN", () => {
        // The tenant vouched for the UPN's domain only.
        expect(
            microsoftDomainAssertion({
                tid: REAL_TENANT,
                preferred_username: "bob@acme.com",
                email: "bob@personal.example",
            }),
        ).toBeUndefined();
    });

    it("asserts the UPN domain when no mail attribute is present at all", () => {
        // Entra does not always emit `email` - the reason a custom getUserInfo here would be risky.
        expect(microsoftDomainAssertion({ tid: REAL_TENANT, preferred_username: "bob@acme.com" })).toEqual({
            provider: "microsoft",
            managedDomain: "acme.com",
        });
    });

    it("asserts nothing when the claims are missing, malformed or not an object", () => {
        for (const profile of [undefined, null, "not-a-token", 42, {}, { tid: REAL_TENANT }]) {
            expect(microsoftDomainAssertion(profile)).toBeUndefined();
        }
    });

    it("normalises case, because a UPN is not guaranteed to be lowercase", () => {
        const assertion = microsoftDomainAssertion({ tid: REAL_TENANT, preferred_username: "Bob@Acme.COM" });
        expect(assertion).toEqual({ provider: "microsoft", managedDomain: "acme.com" });
        expect(assertedCompanyDomain(assertion, "acme.com")).toBe(true);
    });
});
