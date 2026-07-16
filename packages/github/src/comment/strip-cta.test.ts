import { describe, expect, it } from "vitest";
import { renderMarkdown, SEE_PREVIEW_CTA_LABEL } from "./markdown";
import { payloadBuilder } from "./payload";
import { stripCtaFromBody } from "./strip-cta";

const PREVIEW_URL = "https://preview.example.com";
const SUMMARY_URL = "https://autonoma.app/summary";
const ASSET_BASE_URL = "https://cdn.autonoma.app/github-comment/";

describe("stripCtaFromBody", () => {
    it("removes the See preview link but keeps the Open in Autonoma button and the results", () => {
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
        expect(body).toContain(
            "[![See preview](<https://cdn.autonoma.app/github-comment/see-preview-button-v2.svg>)](<https://preview.example.com>)",
        );

        const stripped = stripCtaFromBody(body, SEE_PREVIEW_CTA_LABEL);

        // The preview link is gone.
        expect(stripped).not.toContain(PREVIEW_URL);
        expect(stripped).not.toContain("See preview");
        // The Open in Autonoma image-link and the comment content survive.
        expect(stripped).toContain("open-in-autonoma-button-v2.svg");
        expect(stripped).toContain(SUMMARY_URL);
        expect(stripped).toContain("Checkout button is hidden");
        // No dangling separator left behind on the CTA line.
        expect(stripped).not.toContain(" · ");
    });

    it("removes the See preview text link but keeps the other CTA (no assets)", () => {
        const body = renderMarkdown(
            payloadBuilder({
                state: "critical",
                prNumber: 42,
                summaryUrl: SUMMARY_URL,
                previewUrl: PREVIEW_URL,
                bugs: [{ title: "Checkout button is hidden", href: "https://autonoma.app/bug/1" }],
            }),
        );
        expect(body).toContain("[👁 See preview](<https://preview.example.com>)");

        const stripped = stripCtaFromBody(body, SEE_PREVIEW_CTA_LABEL);

        expect(stripped).not.toContain(PREVIEW_URL);
        expect(stripped).not.toContain("See preview");
        expect(stripped).toContain("[↗ Open in Autonoma](<https://autonoma.app/summary>)");
        // No dangling separator left behind.
        expect(stripped).not.toContain(" · ");
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
        expect(body).toContain(
            "[![See preview](<https://cdn.autonoma.app/github-comment/see-preview-button-v2.svg>)](<https://preview.example.com>)",
        );

        const stripped = stripCtaFromBody(body, SEE_PREVIEW_CTA_LABEL);

        expect(stripped).not.toContain(PREVIEW_URL);
        expect(stripped).not.toContain("See preview");
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

    // Comments posted before the text-first refactor used the old HTML anchor/image forms. Teardown must
    // still strip their "See preview" CTA in place, so the legacy patterns are retained.
    it("strips See preview from a legacy asset-button comment", () => {
        const legacyBody = [
            "<!-- autonoma:pr-comment:v2 -->",
            "",
            '<a href="https://autonoma.app/summary" target="_blank" rel="noopener noreferrer"><img src="https://cdn.autonoma.app/github-comment/open-in-autonoma-button-v2.svg" alt="Open in Autonoma" width="150" /></a>&nbsp;&nbsp;<a href="https://preview.example.com" target="_blank" rel="noopener noreferrer"><img src="https://cdn.autonoma.app/github-comment/see-preview-button-v2.svg" alt="See preview" width="150" /></a>',
        ].join("\n");

        const stripped = stripCtaFromBody(legacyBody, SEE_PREVIEW_CTA_LABEL);

        expect(stripped).not.toContain("See preview");
        expect(stripped).not.toContain(PREVIEW_URL);
        expect(stripped).toContain('alt="Open in Autonoma"');
        expect(stripped).not.toContain("&nbsp;&nbsp;");
    });

    it("strips See preview from a legacy text-link comment", () => {
        const legacyBody = [
            "<!-- autonoma:pr-comment:v2 -->",
            "",
            '<a href="https://autonoma.app/summary" target="_blank" rel="noopener noreferrer">↗ Open in Autonoma</a> | <a href="https://preview.example.com" target="_blank" rel="noopener noreferrer">👁 See preview</a>',
        ].join("\n");

        const stripped = stripCtaFromBody(legacyBody, SEE_PREVIEW_CTA_LABEL);

        expect(stripped).not.toContain("See preview");
        expect(stripped).not.toContain(PREVIEW_URL);
        expect(stripped).toContain("↗ Open in Autonoma</a>");
        expect(stripped).not.toContain(" | ");
    });
});
