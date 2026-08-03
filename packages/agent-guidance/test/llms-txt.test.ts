import { describe, expect, it } from "vitest";
import { aiCatalog } from "../src/ai-catalog";
import { llmsTxt } from "../src/llms-txt";

/**
 * This file exists because the path otherwise falls through to the SPA and answers 200 with
 * the app shell. So what matters is that it is a valid pointer file whose links follow the
 * environment, not the prose.
 */
describe("llmsTxt", () => {
    const text = llmsTxt({ apiUrl: "https://api.beta.autonoma.app", appUrl: "https://beta.autonoma.app" });

    it("opens with the heading and summary the convention expects", () => {
        const lines = text.split("\n");
        expect(lines[0]).toBe("# Autonoma");
        expect(text).toContain("\n> ");
    });

    it("points at the catalog first, since that is the entry point", () => {
        expect(text.indexOf("/.well-known/ai-catalog.json")).toBeLessThan(text.indexOf("/v1/mcp/debug"));
    });

    it("uses the environment it is served from, not production", () => {
        expect(text).toContain("https://api.beta.autonoma.app/v1/mcp/debug");
        expect(text).toContain("https://beta.autonoma.app/settings/api-keys");
        expect(text).not.toContain("https://api.autonoma.app/");
    });

    it("does not double slashes when origins have trailing ones", () => {
        const trailing = llmsTxt({ apiUrl: "https://api.autonoma.app/", appUrl: "https://autonoma.app/" });

        expect(trailing).not.toContain(".app//");
    });

    it("tells a headless caller the header to send", () => {
        expect(text).toContain("Authorization: Bearer");
    });

    it("lists every surface the catalog does, so the two cannot disagree", () => {
        const catalog = aiCatalog({ apiUrl: "https://api.beta.autonoma.app" });

        // Rendered from the catalog rather than written out again: a new MCP server has to
        // reach both documents, and nothing reading this file could notice if it did not.
        for (const entry of catalog.entries) {
            expect(text).toContain(entry.url);
            expect(text).toContain(entry.displayName);
        }
    });
});
