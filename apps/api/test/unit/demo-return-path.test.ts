import { describe, expect, it } from "vitest";
import { resolveReturnPath } from "../../src/demo/resolve-return-path";

const APP_URL = "https://autonoma.app";

describe("resolveReturnPath", () => {
    it("keeps an app-relative path with its query string", () => {
        expect(resolveReturnPath("/onboarding/add-app?appId=abc", APP_URL)).toBe("/onboarding/add-app?appId=abc");
    });

    it("has no path to return to when none was supplied", () => {
        expect(resolveReturnPath(undefined, APP_URL)).toBeUndefined();
        expect(resolveReturnPath("", APP_URL)).toBeUndefined();
    });

    it("drops anything that would leave our origin", () => {
        expect(resolveReturnPath("https://evil.com/steal", APP_URL)).toBeUndefined();
        expect(resolveReturnPath("//evil.com/steal", APP_URL)).toBeUndefined();
        expect(resolveReturnPath("/\\evil.com/steal", APP_URL)).toBeUndefined();
        expect(resolveReturnPath("javascript:alert(1)", APP_URL)).toBeUndefined();
    });

    it("drops a path that only looks relative", () => {
        expect(resolveReturnPath("onboarding", APP_URL)).toBeUndefined();
        expect(resolveReturnPath(" /onboarding", APP_URL)).toBeUndefined();
    });
});
