import { describe, expect, it } from "vitest";
import { isPreviewHostname, isPreviewOrigin, isPreviewUrl, previewOrigin } from "../src/preview-url";

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
});

describe("isPreviewUrl", () => {
    it("accepts a preview URL with or without a deep path", () => {
        expect(isPreviewUrl(`https://${HOST}`, DOMAIN)).toBe(true);
        expect(isPreviewUrl(`https://${HOST}/checkout?step=2#total`, DOMAIN)).toBe(true);
    });

    it("rejects hosts that merely nest under or resemble the preview domain", () => {
        expect(isPreviewUrl("https://evil-preview.autonoma.app", DOMAIN)).toBe(false);
        expect(isPreviewUrl("https://x.preview.autonoma.app.attacker.com", DOMAIN)).toBe(false);
        expect(isPreviewUrl("https://preview.autonoma.app", DOMAIN)).toBe(false);
        // Nests correctly but the label is not the hex digest previewkit generates.
        expect(isPreviewUrl("https://not-hex.preview.autonoma.app", DOMAIN)).toBe(false);
        expect(isPreviewUrl("https://a.b.preview.autonoma.app", DOMAIN)).toBe(false);
    });

    it("rejects other autonoma hosts", () => {
        expect(isPreviewUrl("https://autonoma.app/app", DOMAIN)).toBe(false);
        expect(isPreviewUrl("https://api.autonoma.app", DOMAIN)).toBe(false);
    });

    it("rejects non-https schemes, including javascript: and data:", () => {
        expect(isPreviewUrl(`http://${HOST}`, DOMAIN)).toBe(false);
        expect(isPreviewUrl("javascript:alert(1)//a3f8b21c4d9e.preview.autonoma.app", DOMAIN)).toBe(false);
        expect(isPreviewUrl("data:text/html,<script>alert(1)</script>", DOMAIN)).toBe(false);
    });

    it("rejects unparseable input", () => {
        expect(isPreviewUrl("", DOMAIN)).toBe(false);
        expect(isPreviewUrl("not a url", DOMAIN)).toBe(false);
        expect(isPreviewUrl(`//${HOST}`, DOMAIN)).toBe(false);
    });

    it("honors a non-default internal domain", () => {
        expect(isPreviewUrl("https://a3f8b21c4d9e.preview.beta.autonoma.app", "beta.autonoma.app")).toBe(true);
        expect(isPreviewUrl(`https://${HOST}`, "beta.autonoma.app")).toBe(false);
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

    // Parsing a URL is looser than the anchored regex this replaced, in ways worth
    // pinning down: a non-default port is rejected, while the two spellings that
    // normalize to an identical origin are accepted.
    it("rejects a non-default port", () => {
        expect(isPreviewOrigin(`https://${HOST}:8443`, DOMAIN)).toBe(false);
        expect(isPreviewOrigin(`https://${HOST}:80`, DOMAIN)).toBe(false);
        expect(isPreviewUrl(`https://${HOST}:8443/checkout`, DOMAIN)).toBe(false);
    });

    it("accepts spellings that normalize to the same origin", () => {
        // :443 is the https default, so the parser drops it entirely.
        expect(isPreviewOrigin(`https://${HOST}:443`, DOMAIN)).toBe(true);
        // Hostnames are case-insensitive; the parser lowercases both.
        expect(isPreviewOrigin(`HTTPS://${HOST.toUpperCase()}`, DOMAIN)).toBe(true);
    });

    it("applies the same host and scheme rules as isPreviewUrl", () => {
        expect(isPreviewOrigin("https://not-hex.preview.autonoma.app", DOMAIN)).toBe(false);
        expect(isPreviewOrigin(`http://${HOST}`, DOMAIN)).toBe(false);
    });
});

describe("previewOrigin", () => {
    // Instances are stored by origin, so a deep link must normalize to the same key.
    it("strips path, query and fragment down to the stored origin", () => {
        expect(previewOrigin(`https://${HOST}/checkout?step=2#total`)).toBe(`https://${HOST}`);
    });

    it("strips the trailing slash a browser adds to a bare origin", () => {
        expect(previewOrigin(`https://${HOST}/`)).toBe(`https://${HOST}`);
    });

    it("leaves an already-bare origin alone", () => {
        expect(previewOrigin(`https://${HOST}`)).toBe(`https://${HOST}`);
    });

    it("returns undefined for unparseable input", () => {
        expect(previewOrigin("not a url")).toBeUndefined();
    });
});
