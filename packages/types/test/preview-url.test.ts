import { describe, expect, it } from "vitest";
import { isPreviewHostname, isPreviewOrigin } from "../src/preview-url";

const DOMAIN = "autonoma.app";
// What buildAppHostname actually emits: 12 hex characters of an HMAC digest.
const HOST = "a3f8b21c4d9e.preview.autonoma.app";

describe("isPreviewHostname", () => {
    // The loose check the UI uses to ask "am I running inside a preview?" - no
    // scheme, no label shape, because there is no attacker in that question.
    it("accepts any label under the preview domain", () => {
        expect(isPreviewHostname(HOST, DOMAIN)).toBe(true);
        expect(isPreviewHostname("not-hex.preview.autonoma.app", DOMAIN)).toBe(true);
    });

    it("rejects hosts outside the preview domain", () => {
        expect(isPreviewHostname("autonoma.app", DOMAIN)).toBe(false);
        expect(isPreviewHostname("evil-preview.autonoma.app", DOMAIN)).toBe(false);
        expect(isPreviewHostname("preview.autonoma.app", DOMAIN)).toBe(false);
    });

    it("honors a non-default internal domain", () => {
        expect(isPreviewHostname("x.preview.beta.autonoma.app", "beta.autonoma.app")).toBe(true);
        expect(isPreviewHostname(HOST, "beta.autonoma.app")).toBe(false);
    });
});

describe("isPreviewOrigin", () => {
    // The API's CORS / trusted-origin check: an Origin header is scheme+host only,
    // so anything carrying a path is not one.
    it("accepts a bare origin, with or without the trailing slash a URL parse adds", () => {
        expect(isPreviewOrigin(`https://${HOST}`, DOMAIN)).toBe(true);
        expect(isPreviewOrigin(`https://${HOST}/`, DOMAIN)).toBe(true);
    });

    it("rejects an origin carrying a path or query", () => {
        expect(isPreviewOrigin(`https://${HOST}/checkout`, DOMAIN)).toBe(false);
        expect(isPreviewOrigin(`https://${HOST}/?a=1`, DOMAIN)).toBe(false);
    });

    it("rejects hosts that merely nest under or resemble the preview domain", () => {
        expect(isPreviewOrigin("https://evil-preview.autonoma.app", DOMAIN)).toBe(false);
        expect(isPreviewOrigin("https://x.preview.autonoma.app.attacker.com", DOMAIN)).toBe(false);
        expect(isPreviewOrigin("https://preview.autonoma.app", DOMAIN)).toBe(false);
        // Nests correctly but the label is not the hex digest previewkit generates.
        expect(isPreviewOrigin("https://not-hex.preview.autonoma.app", DOMAIN)).toBe(false);
        expect(isPreviewOrigin("https://a.b.preview.autonoma.app", DOMAIN)).toBe(false);
    });

    it("rejects other autonoma hosts", () => {
        expect(isPreviewOrigin("https://autonoma.app", DOMAIN)).toBe(false);
        expect(isPreviewOrigin("https://api.autonoma.app", DOMAIN)).toBe(false);
    });

    it("rejects non-https schemes, including javascript: and data:", () => {
        expect(isPreviewOrigin(`http://${HOST}`, DOMAIN)).toBe(false);
        expect(isPreviewOrigin("javascript:alert(1)//a3f8b21c4d9e.preview.autonoma.app", DOMAIN)).toBe(false);
        expect(isPreviewOrigin("data:text/html,<script>alert(1)</script>", DOMAIN)).toBe(false);
    });

    it("rejects unparseable input", () => {
        expect(isPreviewOrigin("", DOMAIN)).toBe(false);
        expect(isPreviewOrigin("not a url", DOMAIN)).toBe(false);
        expect(isPreviewOrigin(`//${HOST}`, DOMAIN)).toBe(false);
    });
});
