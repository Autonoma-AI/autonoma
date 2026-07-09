import { describe, expect, it } from "vitest";
import { renderMarkdown, SEE_PREVIEW_CTA_LABEL } from "./markdown";
import { payloadBuilder } from "./payload";
import { stripCtaFromBody } from "./strip-cta";

const PREVIEW_URL = "https://preview.example.com";
const SUMMARY_URL = "https://autonoma.app/summary";
const ASSET_BASE_URL = "https://cdn.autonoma.app/github-comment/";

describe("stripCtaFromBody", () => {
    it("removes the See preview asset button but keeps the other CTA and the results", () => {
        const body = renderMarkdown(
            payloadBuilder({
                state: "critical",
                prNumber: 42,
                commitSha: "abc123456789",
                assetBaseUrl: ASSET_BASE_URL,
                summaryUrl: SUMMARY_URL,
                previewUrl: PREVIEW_URL,
                bugs: [{ title: "Checkout button is hidden", href: "https://autonoma.app/bug/1" }],
            }),
        );
        expect(body).toContain(PREVIEW_URL);
        expect(body).toContain("see-preview-button-v2.svg");

        const stripped = stripCtaFromBody(body, SEE_PREVIEW_CTA_LABEL);

        // The preview link and its button image are gone.
        expect(stripped).not.toContain(PREVIEW_URL);
        expect(stripped).not.toContain("see-preview-button-v2.svg");
        expect(stripped).not.toContain('alt="See preview"');
        // The other CTA and the comment content survive.
        expect(stripped).toContain("open-in-autonoma-button-v2.svg");
        expect(stripped).toContain(SUMMARY_URL);
        expect(stripped).toContain("Checkout button is hidden");
        // No dangling separator left behind on the CTA line.
        expect(stripped).not.toContain("&nbsp;&nbsp;<a");
    });

    it("removes the See preview text link but keeps the other CTA", () => {
        const body = renderMarkdown(
            payloadBuilder({
                state: "critical",
                prNumber: 42,
                summaryUrl: SUMMARY_URL,
                previewUrl: PREVIEW_URL,
                bugs: [{ title: "Checkout button is hidden", href: "https://autonoma.app/bug/1" }],
            }),
        );
        expect(body).toContain(
            '<a href="https://preview.example.com" target="_blank" rel="noopener noreferrer">👁 See preview</a>',
        );

        const stripped = stripCtaFromBody(body, SEE_PREVIEW_CTA_LABEL);

        expect(stripped).not.toContain(PREVIEW_URL);
        expect(stripped).not.toContain("See preview");
        expect(stripped).toContain(
            '<a href="https://autonoma.app/summary" target="_blank" rel="noopener noreferrer">↗ Open in Autonoma</a>',
        );
        // No dangling " | " separator left behind.
        expect(stripped).not.toContain("Open in Autonoma</a> | ");
    });

    it("drops the whole CTA line when See preview was the only CTA", () => {
        const body = renderMarkdown(
            payloadBuilder({
                state: "running",
                prNumber: 42,
                assetBaseUrl: ASSET_BASE_URL,
                previewUrl: PREVIEW_URL,
            }),
        );
        expect(body).toContain("see-preview-button-v2.svg");

        const stripped = stripCtaFromBody(body, SEE_PREVIEW_CTA_LABEL);

        expect(stripped).not.toContain(PREVIEW_URL);
        expect(stripped).not.toContain("see-preview-button-v2.svg");
        // No blank line left dangling where the CTA line used to be.
        expect(stripped).not.toMatch(/\n\n\n/);
    });

    it("returns the body unchanged when the label is absent", () => {
        const body = renderMarkdown(
            payloadBuilder({
                state: "healthy",
                prNumber: 42,
                summaryUrl: SUMMARY_URL,
            }),
        );
        expect(body).not.toContain("See preview");

        expect(stripCtaFromBody(body, SEE_PREVIEW_CTA_LABEL)).toBe(body);
    });
});
