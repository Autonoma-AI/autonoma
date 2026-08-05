import { describe, expect, it } from "vitest";
import { isPrimaryAppAmbiguous, isSdkAppAmbiguous } from "../src/schemas/previewkit-config";
import type { PreviewkitManifest } from "../src/types/previewkit-manifest";
import { resolveDeclaredSdkAppUrl, resolvePrimaryUrl, resolveSdkAppUrl } from "../src/types/previewkit-preview-urls";

const WEB_URL = "https://web.preview.example.com";
const API_URL = "https://api.preview.example.com";

const manifest = (
    ...apps: Array<{ name: string; primary?: boolean; sdk_implemented?: boolean }>
): PreviewkitManifest => ({ apps });

describe("resolvePrimaryUrl", () => {
    it("returns the URL of the app marked primary", () => {
        const urls = { api: API_URL, web: WEB_URL };
        expect(resolvePrimaryUrl(manifest({ name: "api" }, { name: "web", primary: true }), urls)).toBe(WEB_URL);
    });

    it("falls back to the first declared app when none is marked primary", () => {
        const urls = { api: API_URL, web: WEB_URL };
        expect(resolvePrimaryUrl(manifest({ name: "api" }, { name: "web" }), urls)).toBe(API_URL);
    });

    it("falls back to the first declared app when every app is primary: false", () => {
        const urls = { api: API_URL, web: WEB_URL };
        const config = manifest({ name: "api", primary: false }, { name: "web", primary: false });
        expect(resolvePrimaryUrl(config, urls)).toBe(API_URL);
    });

    // The preview origin is what the browsing agents are pointed at, so a primary app that is not up
    // must read as "no preview" rather than silently resolving to some other app's origin.
    it("returns undefined when the primary app has no URL, rather than another app's", () => {
        expect(resolvePrimaryUrl(manifest({ name: "web", primary: true }), { api: API_URL })).toBeUndefined();
    });

    it("returns undefined when the config declared no apps", () => {
        expect(resolvePrimaryUrl({}, { api: API_URL })).toBeUndefined();
    });
});

describe("resolveSdkAppUrl", () => {
    it("returns the URL of the app flagged sdk_implemented", () => {
        const urls = { api: API_URL, web: WEB_URL };
        const config = manifest({ name: "api", sdk_implemented: true }, { name: "web", primary: true });
        expect(resolveSdkAppUrl(config, urls)).toBe(API_URL);
    });

    it("falls back to the primary app when no app declares the SDK", () => {
        const urls = { api: API_URL, web: WEB_URL };
        expect(resolveSdkAppUrl(manifest({ name: "api" }, { name: "web", primary: true }), urls)).toBe(WEB_URL);
    });

    // A front-end repo whose API lives in a connected repo declares the flag on that dependency's app, and the
    // deploy has to honor it - the declaration is the customer stating where the handler is.
    it("honors a declaration made by a dependency repo's app", () => {
        const merged = manifest({ name: "web", primary: true }, { name: "api", sdk_implemented: true });
        expect(resolveSdkAppUrl(merged, { api: API_URL, web: WEB_URL })).toBe(API_URL);
    });

    // The environment persists one merged config, so which repo contributed an app is not recoverable at read
    // time and the undeclared fallback is resolved over the whole topology. Pinned because it is a real sharp
    // edge, not because it is desirable: #2062 removes the guess.
    it("resolves the undeclared fallback over the merged topology, dependency apps included", () => {
        const merged = manifest({ name: "api" }, { name: "web" });
        expect(resolveSdkAppUrl(merged, { api: API_URL, web: WEB_URL })).toBe(API_URL);
    });
});

describe("resolveDeclaredSdkAppUrl", () => {
    it("returns the declared SDK app's URL", () => {
        const config = manifest({ name: "api", sdk_implemented: true }, { name: "web", primary: true });
        expect(resolveDeclaredSdkAppUrl(config, { api: API_URL, web: WEB_URL })).toBe(API_URL);
    });

    // The whole point of this resolver: an explicit answer must be distinguishable from the
    // primary-app fallback that resolveSdkAppUrl folds in.
    it("returns undefined when nothing declares the SDK, without falling back to primary", () => {
        const config = manifest({ name: "api" }, { name: "web", primary: true });
        expect(resolveDeclaredSdkAppUrl(config, { api: API_URL, web: WEB_URL })).toBeUndefined();
    });
});

/**
 * With several apps and no `primary` flag, declaration order decides which application the agents browse. The
 * predicate has to catch exactly that shape - not the single-app case, where demanding a flag is pure friction.
 */
describe("isPrimaryAppAmbiguous", () => {
    it("is not ambiguous when only one app exists", () => {
        expect(isPrimaryAppAmbiguous([{ name: "web" }])).toBe(false);
    });

    it("is not ambiguous when one of several apps is marked primary", () => {
        expect(isPrimaryAppAmbiguous([{ name: "api" }, { name: "web", primary: true }])).toBe(false);
    });

    it("is ambiguous when several apps exist and none is marked primary", () => {
        expect(isPrimaryAppAmbiguous([{ name: "connect" }, { name: "dashboard" }])).toBe(true);
    });

    it("is not ambiguous for an empty config, which resolves to no app at all", () => {
        expect(isPrimaryAppAmbiguous([])).toBe(false);
    });
});

/**
 * Ambiguous even when `primary` IS declared: hosting the UI says nothing about hosting the Environment Factory
 * handler. A wrong answer sends scenario setup to an app with no handler.
 */
describe("isSdkAppAmbiguous", () => {
    it("is not ambiguous when only one app exists", () => {
        expect(isSdkAppAmbiguous([{ name: "web" }])).toBe(false);
    });

    it("is not ambiguous when an app declares itself the SDK host", () => {
        expect(
            isSdkAppAmbiguous([
                { name: "web", primary: true },
                { name: "api", sdk_implemented: true },
            ]),
        ).toBe(false);
    });

    it("is ambiguous when several apps exist and none declares the SDK host", () => {
        expect(isSdkAppAmbiguous([{ name: "os-frontend" }, { name: "os-backend" }])).toBe(true);
    });

    // The common production shape: primary is known, the handler's home is not.
    it("is ambiguous even when the primary app is declared", () => {
        expect(isSdkAppAmbiguous([{ name: "web-app", primary: true }, { name: "db-api" }])).toBe(true);
    });
});
