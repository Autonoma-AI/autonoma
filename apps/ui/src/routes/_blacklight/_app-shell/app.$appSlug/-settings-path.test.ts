import { describe, expect, test } from "vitest";
import { isSettingsPath } from "./-settings-path";

describe("isSettingsPath", () => {
    test("exempts the settings surfaces the setup steps link out to", () => {
        // Both are linked, in a new tab, from steps that run while setup is unfinished -
        // so gating them would send the flow's own links back to the flow.
        expect(isSettingsPath("/app/acme-web/settings/api-keys", "acme-web")).toBe(true);
        expect(isSettingsPath("/app/acme-web/settings/previews", "acme-web")).toBe(true);
    });

    test("exempts the settings index", () => {
        expect(isSettingsPath("/app/acme-web/settings", "acme-web")).toBe(true);
    });

    test("does not exempt the dashboard the gate exists to keep people out of", () => {
        expect(isSettingsPath("/app/acme-web", "acme-web")).toBe(false);
        expect(isSettingsPath("/app/acme-web/tests", "acme-web")).toBe(false);
        expect(isSettingsPath("/app/acme-web/pull-requests", "acme-web")).toBe(false);
    });

    test("does not exempt another app's settings", () => {
        // The slug is part of the check, so a path under a different app cannot open
        // the gate for this one.
        expect(isSettingsPath("/app/other-app/settings/api-keys", "acme-web")).toBe(false);
    });
});
