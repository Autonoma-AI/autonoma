import { describe, expect, it } from "vitest";
import { unauthorizedGuidance } from "../src/unauthorized";

/**
 * The reason this package exists is that a caller with no browser used to get
 * `{"error":"Unauthorized"}` and had no way to learn an API key would work. These pin the
 * facts a headless caller needs, not the prose around them.
 */
describe("unauthorizedGuidance", () => {
    it("tells a headless caller how to authenticate without a browser", () => {
        const guidance = unauthorizedGuidance({ surface: "mcp" });

        const apiKey = guidance.authenticate.find((option) => option.method === "api_key");
        expect(apiKey).toBeDefined();
        expect(apiKey?.howTo).toContain("Authorization: Bearer");
    });

    it("offers the API key before the browser flow, since only one of them always works", () => {
        const guidance = unauthorizedGuidance({ surface: "mcp" });

        expect(guidance.authenticate[0]?.method).toBe("api_key");
    });

    it("points at the caller's own environment when one is given", () => {
        const guidance = unauthorizedGuidance({ appUrl: "https://beta.autonoma.app", surface: "api" });

        expect(guidance.authenticate.find((option) => option.method === "api_key")?.howTo).toContain(
            "https://beta.autonoma.app/settings/api-keys",
        );
    });

    it("still returns a usable link when the caller has no environment context", () => {
        const guidance = unauthorizedGuidance({ surface: "api" });

        expect(guidance.authenticate.find((option) => option.method === "api_key")?.howTo).toContain(
            "https://autonoma.app/settings/api-keys",
        );
    });

    it("documents the surface that was actually called", () => {
        expect(unauthorizedGuidance({ surface: "mcp" }).documentation).toBe("https://docs.autonoma.app/mcp/");
        expect(unauthorizedGuidance({ surface: "api" }).documentation).not.toBe("https://docs.autonoma.app/mcp/");
    });

    it("names the surface so an agent handed a bare URL learns what it hit", () => {
        expect(unauthorizedGuidance({ surface: "mcp" }).resource).toContain("MCP");
    });
});
