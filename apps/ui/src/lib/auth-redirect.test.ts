import { describe, expect, it } from "vitest";
import { absoluteRedirectUrl, safeRedirectTo } from "./auth-redirect";

describe("safeRedirectTo", () => {
    it("keeps a same-origin path with its query and hash", () => {
        expect(safeRedirectTo("/preview-waiting?to=https%3A%2F%2Fx")).toBe("/preview-waiting?to=https%3A%2F%2Fx");
        expect(safeRedirectTo("/app/acme/pull-requests/42#tests")).toBe("/app/acme/pull-requests/42#tests");
    });

    it("falls back to the app root when there is nothing to return to", () => {
        expect(safeRedirectTo(undefined)).toBe("/");
        expect(safeRedirectTo("")).toBe("/");
    });

    // The value survives a round trip through an external identity provider and is
    // then handed to the browser, so anything absolute is an open redirect.
    it("rejects absolute URLs", () => {
        expect(safeRedirectTo("https://evil.example")).toBe("/");
        expect(safeRedirectTo("http://evil.example")).toBe("/");
        expect(safeRedirectTo("javascript:alert(1)")).toBe("/");
    });

    it("rejects protocol-relative and backslash forms a naive slash check would allow", () => {
        expect(safeRedirectTo("//evil.example")).toBe("/");
        expect(safeRedirectTo("/\\evil.example")).toBe("/");
    });
});

describe("absoluteRedirectUrl", () => {
    it("joins a validated path onto the origin", () => {
        expect(absoluteRedirectUrl("https://autonoma.app", "/preview-waiting?to=x")).toBe(
            "https://autonoma.app/preview-waiting?to=x",
        );
    });

    // Every sign-in flows through here, so with nothing to return to the result must
    // be byte-identical to the bare origin this codepath sent before redirectTo existed.
    it("returns the bare origin when there is nothing to return to", () => {
        expect(absoluteRedirectUrl("https://autonoma.app", undefined)).toBe("https://autonoma.app");
        expect(absoluteRedirectUrl("https://autonoma.app", "")).toBe("https://autonoma.app");
    });

    it("returns the bare origin when the candidate is rejected", () => {
        expect(absoluteRedirectUrl("https://autonoma.app", "//evil.example")).toBe("https://autonoma.app");
        expect(absoluteRedirectUrl("https://autonoma.app", "https://evil.example")).toBe("https://autonoma.app");
    });
});
