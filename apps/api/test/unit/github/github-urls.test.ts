import { describe, expect, it } from "vitest";
import { configureInstallationUrl } from "../../../src/github/github-urls";

describe("configureInstallationUrl", () => {
    /**
     * The org form is not cosmetic. An organization's installation does not exist under the
     * personal `/settings/installations/<id>` path - GitHub answers 404, not a redirect - so a
     * message telling someone to uninstall there is a dead end at the moment they most need it.
     */
    it("addresses an organization installation under the organization", () => {
        expect(configureInstallationUrl(4242, { login: "acme", type: "Organization" })).toBe(
            "https://github.com/organizations/acme/settings/installations/4242",
        );
    });

    it("addresses a user installation under personal settings", () => {
        expect(configureInstallationUrl(4242, { login: "ada", type: "User" })).toBe(
            "https://github.com/settings/installations/4242",
        );
    });

    it("falls back to the personal form when the account kind is unknown", () => {
        expect(configureInstallationUrl(4242)).toBe("https://github.com/settings/installations/4242");
    });

    /** Never the account picker: that URL is how someone ends up installing on a second account. */
    it("never points at the app's install page", () => {
        const url = configureInstallationUrl(4242, { login: "acme", type: "Organization" });
        expect(url).not.toContain("installations/new");
        expect(url).not.toContain("/apps/");
    });
});
