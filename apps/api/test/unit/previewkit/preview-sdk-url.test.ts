import { describe, expect, it } from "vitest";
import { derivePreviewSdkUrl } from "../../../src/routes/deployments/preview-sdk-url";

describe("derivePreviewSdkUrl", () => {
    it("combines the preview origin with the main webhook path and query", () => {
        const result = derivePreviewSdkUrl(
            "https://abc123.preview.autonoma.app",
            "https://api.customer.com/__autonoma/sdk?v=2",
        );
        expect(result).toBe("https://abc123.preview.autonoma.app/__autonoma/sdk?v=2");
    });

    it("ignores the main webhook host and port, keeping only its path", () => {
        const result = derivePreviewSdkUrl("https://abc123.preview.autonoma.app", "https://localhost:3000/api/sdk");
        expect(result).toBe("https://abc123.preview.autonoma.app/api/sdk");
    });

    it("falls back to the preview origin when no main webhook is configured", () => {
        expect(derivePreviewSdkUrl("https://abc123.preview.autonoma.app/path", undefined)).toBe(
            "https://abc123.preview.autonoma.app",
        );
        expect(derivePreviewSdkUrl("https://abc123.preview.autonoma.app", "")).toBe(
            "https://abc123.preview.autonoma.app",
        );
    });

    it("returns undefined when there is no preview URL", () => {
        expect(derivePreviewSdkUrl(undefined, "https://api.customer.com/sdk")).toBeUndefined();
        expect(derivePreviewSdkUrl(null, "https://api.customer.com/sdk")).toBeUndefined();
        expect(derivePreviewSdkUrl("", "https://api.customer.com/sdk")).toBeUndefined();
    });

    it("returns the raw preview value when it is not a parseable URL", () => {
        expect(derivePreviewSdkUrl("not-a-url", "https://api.customer.com/sdk")).toBe("not-a-url");
    });

    it("falls back to the preview origin when the main webhook is unparseable", () => {
        expect(derivePreviewSdkUrl("https://abc123.preview.autonoma.app", "not-a-url")).toBe(
            "https://abc123.preview.autonoma.app",
        );
    });
});
