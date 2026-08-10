import { describe, expect, it } from "vitest";
import { emailAutoJoinsOrg, orgHasAutoJoinDomain } from "./org-domain";

describe("orgHasAutoJoinDomain", () => {
    it("is true only for a bare domain, which is what makes signups join on their own", () => {
        expect(orgHasAutoJoinDomain("acme.com")).toBe(true);
        expect(orgHasAutoJoinDomain("tom@gmail.com")).toBe(false);
        expect(orgHasAutoJoinDomain(undefined)).toBe(false);
    });
});

describe("emailAutoJoinsOrg", () => {
    it("is true only when the address sits on the organization's own auto-join domain", () => {
        expect(emailAutoJoinsOrg("bob@acme.com", "acme.com")).toBe(true);
    });

    it("is false for an address outside that domain, which is the whole point of an invitation", () => {
        // The bug: a company organization could not invite a contractor, a partner, or a founder's
        // personal address, because the check only asked whether the ORGANIZATION was domain-keyed.
        expect(emailAutoJoinsOrg("tomas.piaggio12@gmail.com", "autonoma.app")).toBe(false);
        expect(emailAutoJoinsOrg("bob@partner.com", "acme.com")).toBe(false);
    });

    it("is false for an organization nobody is auto-joined into", () => {
        expect(emailAutoJoinsOrg("bob@acme.com", "tom@gmail.com")).toBe(false);
        expect(emailAutoJoinsOrg("bob@acme.com", undefined)).toBe(false);
    });

    it("ignores case and surrounding whitespace on both sides", () => {
        expect(emailAutoJoinsOrg("Bob@Acme.COM", " acme.com ")).toBe(true);
    });

    it("is false for an address with no domain at all", () => {
        expect(emailAutoJoinsOrg("not-an-email", "acme.com")).toBe(false);
        expect(emailAutoJoinsOrg("trailing@", "acme.com")).toBe(false);
    });
});
