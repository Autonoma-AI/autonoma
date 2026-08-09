import { describe, expect, it } from "vitest";
import { isConsumerEmailDomain } from "./consumer-email-domains";

describe("isConsumerEmailDomain", () => {
    it("recognises the providers that actually pooled strangers together", () => {
        // outlook.com is not hypothetical: an "Outlook" organization accumulated three unrelated
        // people while this list held only gmail.com.
        for (const domain of ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com"]) {
            expect(isConsumerEmailDomain(domain)).toBe(true);
        }
    });

    it("covers the country variants, which are the easiest ones to miss", () => {
        // Microsoft and Yahoo shipped a domain per market and they all still receive mail, so a
        // signup from one of these is no more a colleague than one from the .com.
        for (const domain of [
            "outlook.es",
            "outlook.com.br",
            "hotmail.co.uk",
            "hotmail.com.mx",
            "live.com.au",
            "yahoo.co.jp",
            "yahoo.com.ar",
            "gmx.de",
            "aol.fr",
        ]) {
            expect(isConsumerEmailDomain(domain)).toBe(true);
        }
    });

    it("covers privacy providers, regional portals and ISP mailboxes", () => {
        for (const domain of [
            "proton.me",
            "tuta.com",
            "posteo.de",
            "uol.com.br",
            "terra.com.br",
            "qq.com",
            "163.com",
            "naver.com",
            "mail.ru",
            "yandex.ru",
            "seznam.cz",
            "wp.pl",
            "libero.it",
            "orange.fr",
            "comcast.net",
            "btinternet.com",
            "bigpond.com",
            "rediffmail.com",
        ]) {
            expect(isConsumerEmailDomain(domain)).toBe(true);
        }
    });

    it("does not claim a company domain", () => {
        for (const domain of ["acme.com", "autonoma.app", "getacme.io", "mycompany.co.uk", "centinel.finance"]) {
            expect(isConsumerEmailDomain(domain)).toBe(false);
        }
    });

    it("does not claim a corporate domain that shares a brand with a consumer one", () => {
        // British Telecom's consumer mailboxes are btinternet.com; bt.com is the company. Likewise
        // au.com is a registry domain sold to businesses, not a mailbox provider.
        for (const domain of ["bt.com", "au.com"]) {
            expect(isConsumerEmailDomain(domain)).toBe(false);
        }
    });

    it("is case and whitespace insensitive, because email domains arrive unnormalised", () => {
        expect(isConsumerEmailDomain("GMAIL.COM")).toBe(true);
        expect(isConsumerEmailDomain("  Outlook.com ")).toBe(true);
    });

    it("cannot recognise a personal domain, which is why this list is a floor and not the mechanism", () => {
        // Proton, Fastmail and iCloud+ all host an individual's own domain. These are one person's
        // mailbox and no denylist can tell them from a company - the fix is to stop auto-joining an
        // unverified domain, not to add entries. Asserted so the limitation is visible rather than
        // discovered later by someone who trusted this function to be sufficient.
        expect(isConsumerEmailDomain("piaggio.dev")).toBe(false);
        // The same hole in the other direction: a domain thousands of unrelated people share.
        expect(isConsumerEmailDomain("stanford.edu")).toBe(false);
    });
});
