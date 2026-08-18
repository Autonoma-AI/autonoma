import { describe, expect, it } from "vitest";
import { DEFAULT_SDK_PATH, applySdkPath, buildSdkUrl, reResolveSdkEndpoint, sdkPathOf } from "./sdk-endpoint";
import { resolveSdkEndpointUrl } from "./types/previewkit-preview-urls";

const ORIGIN = "https://abc123.preview.autonoma.app";

// A split topology: the dashboard (the primary/front app) and the server (the API host that
// actually mounts the Environment Factory handler), each on its own preview origin.
const DASHBOARD = "https://38be14dde383.preview.autonoma.app";
const SERVER = "https://a7ce7522e220.preview.autonoma.app";
const URLS = { dashboard: DASHBOARD, server: SERVER };

describe("buildSdkUrl", () => {
    it("mounts the handler at the declared path", () => {
        expect(buildSdkUrl(ORIGIN, "/autonoma")).toBe(`${ORIGIN}/autonoma`);
    });

    it("falls back to the convention when no path is given", () => {
        expect(buildSdkUrl(ORIGIN)).toBe(`${ORIGIN}${DEFAULT_SDK_PATH}`);
        expect(buildSdkUrl(ORIGIN, undefined)).toBe(`${ORIGIN}${DEFAULT_SDK_PATH}`);
        expect(buildSdkUrl(ORIGIN, null)).toBe(`${ORIGIN}${DEFAULT_SDK_PATH}`);
        expect(buildSdkUrl(ORIGIN, "")).toBe(`${ORIGIN}${DEFAULT_SDK_PATH}`);
    });

    it("does not double the slash on an origin that has a trailing one", () => {
        expect(buildSdkUrl(`${ORIGIN}/`, "/autonoma")).toBe(`${ORIGIN}/autonoma`);
    });
});

describe("applySdkPath", () => {
    it("swaps the path of an existing endpoint, keeping its origin", () => {
        expect(applySdkPath(`${ORIGIN}/api/autonoma`, "/autonoma")).toBe(`${ORIGIN}/autonoma`);
    });

    it("leaves the endpoint untouched when no path is declared", () => {
        // The load-bearing case: an endpoint registered by hand at a path of the
        // customer's choosing must survive an application that declares nothing.
        const registered = "https://api.customer.com/internal/seed";
        expect(applySdkPath(registered, undefined)).toBe(registered);
        expect(applySdkPath(registered, null)).toBe(registered);
        expect(applySdkPath(registered, "")).toBe(registered);
    });

    it("carries the stored query across the swap", () => {
        expect(applySdkPath(`${ORIGIN}/api/autonoma?token=abc`, "/autonoma")).toBe(`${ORIGIN}/autonoma?token=abc`);
    });

    it("returns the input unchanged when it is not a parseable URL", () => {
        expect(applySdkPath("not-a-url", "/autonoma")).toBe("not-a-url");
    });

    it("drops a port only when the origin never had one", () => {
        expect(applySdkPath("http://localhost:3000/api/autonoma", "/seed")).toBe("http://localhost:3000/seed");
    });
});

describe("reResolveSdkEndpoint", () => {
    it("re-points the host when the owning app changed (declared origin differs from the stored one)", () => {
        // The bug: the endpoint was stored against the dashboard (the primary-fallback registration),
        // then `sdk_implemented` moved to the server. The resolved host must follow to the server.
        expect(
            reResolveSdkEndpoint({
                storedEndpoint: `${DASHBOARD}/api/autonoma`,
                declaredSdkAppUrl: SERVER,
                declaredPath: undefined,
            }),
        ).toBe(`${SERVER}${DEFAULT_SDK_PATH}`);
    });

    it("takes the declared path onto the new host, not the stale stored one", () => {
        expect(
            reResolveSdkEndpoint({
                storedEndpoint: `${DASHBOARD}/old/path`,
                declaredSdkAppUrl: SERVER,
                declaredPath: "/api/autonoma",
            }),
        ).toBe(`${SERVER}/api/autonoma`);
    });

    it("preserves a hand-registered path when the SAME app still owns the endpoint", () => {
        const registered = `${SERVER}/internal/seed`;
        expect(
            reResolveSdkEndpoint({ storedEndpoint: registered, declaredSdkAppUrl: SERVER, declaredPath: undefined }),
        ).toBe(registered);
    });

    it("leaves the stored endpoint alone (path only) when no app explicitly declares the SDK host", () => {
        const registered = "https://api.customer.com/internal/seed?token=abc";
        expect(
            reResolveSdkEndpoint({ storedEndpoint: registered, declaredSdkAppUrl: undefined, declaredPath: undefined }),
        ).toBe(registered);
    });

    it("is undefined when there is no stored endpoint to re-resolve", () => {
        expect(
            reResolveSdkEndpoint({ storedEndpoint: undefined, declaredSdkAppUrl: SERVER, declaredPath: undefined }),
        ).toBeUndefined();
    });
});

// The two behaviors the fix has to guarantee, driven the way production does it: from the config's
// `sdk_implemented` flag and the preview's app URLs, through the config-aware resolver.
describe("resolveSdkEndpointUrl", () => {
    const stored = `${DASHBOARD}/api/autonoma`;

    it("moves the resolved endpoint HOST when sdk_implemented moves from one app to another", () => {
        // A: the dashboard owns the handler - stored on the dashboard, so it stays put.
        const onDashboard = resolveSdkEndpointUrl(
            { apps: [{ name: "dashboard", primary: true, sdk_implemented: true }, { name: "server" }] },
            URLS,
            stored,
        );
        expect(onDashboard).toBe(`${DASHBOARD}/api/autonoma`);

        // B: sdk_implemented moves to the server - the SAME stored endpoint now resolves to the server host.
        const onServer = resolveSdkEndpointUrl(
            {
                apps: [
                    { name: "dashboard", primary: true },
                    { name: "server", sdk_implemented: true },
                ],
            },
            URLS,
            stored,
        );
        expect(onServer).toBe(`${SERVER}/api/autonoma`);
        expect(new URL(onServer!).host).toBe(new URL(SERVER).host);
    });

    it("preserves an explicit hand-registered sdk_path on the SAME app (no regression)", () => {
        // The server hosts the handler at a non-conventional path it declared; the stored endpoint
        // already sits on the server. Re-resolution must not rewrite that path to the convention.
        const resolved = resolveSdkEndpointUrl(
            { apps: [{ name: "server", primary: true, sdk_implemented: true, sdk_path: "/internal/seed" }] },
            { server: SERVER },
            `${SERVER}/internal/seed`,
        );
        expect(resolved).toBe(`${SERVER}/internal/seed`);
    });
});

describe("sdkPathOf", () => {
    it("extracts the mount path an endpoint answered on", () => {
        expect(sdkPathOf(`${ORIGIN}/api/autonoma`)).toBe("/api/autonoma");
        expect(sdkPathOf("https://api.customer.com/internal/seed?token=abc")).toBe("/internal/seed");
    });

    it("reports the root for an endpoint that is a bare origin", () => {
        expect(sdkPathOf(ORIGIN)).toBe("/");
    });

    it("is undefined when the input is not a URL", () => {
        expect(sdkPathOf("not-a-url")).toBeUndefined();
    });
});
