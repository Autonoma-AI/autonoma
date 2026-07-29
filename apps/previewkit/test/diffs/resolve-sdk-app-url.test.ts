import { describe, expect, it } from "vitest";
import type { AppRole } from "../../src/config/schema";
import { resolveSdkAppUrl } from "../../src/diffs/resolve-sdk-app-url";

const URLS = {
    api: "https://api.preview.example.com",
    web: "https://web.preview.example.com",
};

describe("resolveSdkAppUrl", () => {
    it("targets the app flagged sdk_implemented, not the browsed frontend", () => {
        const apps: AppRole[] = [
            { name: "api", sdk_implemented: true },
            { name: "web", primary: true },
        ];
        expect(resolveSdkAppUrl(apps, URLS)).toBe(URLS.api);
    });

    it("targets an app that is both the frontend and the SDK host", () => {
        const apps: AppRole[] = [{ name: "web", primary: true, sdk_implemented: true }, { name: "api" }];
        expect(resolveSdkAppUrl(apps, URLS)).toBe(URLS.web);
    });

    it("falls back to the primary app when no app declares the SDK", () => {
        const apps: AppRole[] = [{ name: "api" }, { name: "web", primary: true }];
        expect(resolveSdkAppUrl(apps, URLS)).toBe(URLS.web);
    });

    it("falls back to the first app when nothing is declared at all", () => {
        const apps: AppRole[] = [{ name: "api" }, { name: "web" }];
        expect(resolveSdkAppUrl(apps, URLS)).toBe(URLS.api);
    });

    it("returns undefined when the SDK app has no deployed url", () => {
        const apps: AppRole[] = [{ name: "worker", sdk_implemented: true }];
        expect(resolveSdkAppUrl(apps, URLS)).toBeUndefined();
    });
});
