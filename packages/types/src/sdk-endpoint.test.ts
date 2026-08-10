import { describe, expect, it } from "vitest";
import { DEFAULT_SDK_PATH, applySdkPath, buildSdkUrl, sdkPathOf } from "./sdk-endpoint";

const ORIGIN = "https://abc123.preview.autonoma.app";

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
