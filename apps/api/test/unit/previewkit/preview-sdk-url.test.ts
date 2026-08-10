import { describe, expect, it } from "vitest";
import { derivePreviewSdkUrl } from "../../../src/routes/deployments/preview-sdk-url";

const PREVIEW = "https://abc123.preview.autonoma.app";

describe("derivePreviewSdkUrl", () => {
    it("uses the path the config declares, over the main webhook's", () => {
        const result = derivePreviewSdkUrl({
            origin: PREVIEW,
            declaredPath: "/autonoma",
            mainWebhookUrl: "https://api.customer.com/__autonoma/sdk",
        });
        expect(result).toBe(`${PREVIEW}/autonoma`);
    });

    it("combines the preview origin with the main webhook path and query", () => {
        const result = derivePreviewSdkUrl({
            origin: PREVIEW,
            mainWebhookUrl: "https://api.customer.com/__autonoma/sdk?v=2",
        });
        expect(result).toBe(`${PREVIEW}/__autonoma/sdk?v=2`);
    });

    it("ignores the main webhook host and port, keeping only its path", () => {
        const result = derivePreviewSdkUrl({ origin: PREVIEW, mainWebhookUrl: "https://localhost:3000/api/sdk" });
        expect(result).toBe(`${PREVIEW}/api/sdk`);
    });

    it("falls back to the conventional path when no source names one", () => {
        expect(derivePreviewSdkUrl({ origin: `${PREVIEW}/path` })).toBe(`${PREVIEW}/api/autonoma`);
        expect(derivePreviewSdkUrl({ origin: PREVIEW, declaredPath: "", mainWebhookUrl: "" })).toBe(
            `${PREVIEW}/api/autonoma`,
        );
    });

    it("returns undefined when there is no preview URL", () => {
        expect(
            derivePreviewSdkUrl({ origin: undefined, mainWebhookUrl: "https://api.customer.com/sdk" }),
        ).toBeUndefined();
        expect(derivePreviewSdkUrl({ origin: null })).toBeUndefined();
        expect(derivePreviewSdkUrl({ origin: "" })).toBeUndefined();
    });

    it("returns the raw preview value when it is not a parseable URL", () => {
        expect(derivePreviewSdkUrl({ origin: "not-a-url", mainWebhookUrl: "https://api.customer.com/sdk" })).toBe(
            "not-a-url",
        );
    });

    it("falls back to the conventional path when the main webhook is unparseable", () => {
        expect(derivePreviewSdkUrl({ origin: PREVIEW, mainWebhookUrl: "not-a-url" })).toBe(`${PREVIEW}/api/autonoma`);
    });
});
