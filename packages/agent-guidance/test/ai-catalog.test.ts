import { describe, expect, it } from "vitest";
import { aiCatalog } from "../src/ai-catalog";

/**
 * The catalog is fetched by registries and by agents that know nothing but our domain, so the
 * things worth pinning are that it stays valid against the spec envelope and that its URLs
 * follow the environment rather than being baked to production.
 */
describe("aiCatalog", () => {
    it("advertises the endpoints of the environment it is served from", () => {
        const catalog = aiCatalog({ apiUrl: "https://api-abc123.alpha.autonoma.app" });

        for (const entry of catalog.entries) {
            expect(entry.url.startsWith("https://api-abc123.alpha.autonoma.app/")).toBe(true);
        }
    });

    it("does not double the slash when the origin has a trailing one", () => {
        const catalog = aiCatalog({ apiUrl: "https://api.autonoma.app/" });

        expect(catalog.entries.every((entry) => !entry.url.includes(".app//"))).toBe(true);
    });

    it("carries every field the spec envelope requires", () => {
        const catalog = aiCatalog({ apiUrl: "https://api.autonoma.app" });

        expect(catalog.specVersion).toBe("1.0");
        expect(catalog.host.displayName.length).toBeGreaterThan(0);
        // The spec identifies a host by DID; an ARD validator rejects a bare domain here.
        expect(catalog.host.identifier).toBe("did:web:autonoma.app");
        expect(catalog.entries.length).toBeGreaterThan(0);
        for (const entry of catalog.entries) {
            expect(entry.identifier.startsWith("urn:air:")).toBe(true);
            expect(entry.displayName.length).toBeGreaterThan(0);
            expect(entry.type.length).toBeGreaterThan(0);
            expect(entry.description.length).toBeGreaterThan(0);
            expect(() => new URL(entry.url)).not.toThrow();
        }
    });

    it("uses the spec's urn:air scheme, which a validator enforces", () => {
        // The ARD landing page's example is simplified; the normative schema this is
        // validated against is the AI Catalog spec it defers to.
        const catalog = aiCatalog({ apiUrl: "https://api.autonoma.app" });

        expect(catalog.entries.every((entry) => /^urn:air:[^:]+:[^:]+:[^:]+$/.test(entry.identifier))).toBe(true);
    });

    it("gives every entry a distinct identifier, since registries dedupe on it", () => {
        const catalog = aiCatalog({ apiUrl: "https://api.autonoma.app" });

        const identifiers = catalog.entries.map((entry) => entry.identifier);
        expect(new Set(identifiers).size).toBe(identifiers.length);
    });

    it("lists both MCP servers, which are the surfaces an agent actually connects to", () => {
        const catalog = aiCatalog({ apiUrl: "https://api.autonoma.app" });

        const mcpUrls = catalog.entries
            .filter((entry) => entry.type === "application/mcp-server+json")
            .map((entry) => entry.url);
        expect(mcpUrls).toContain("https://api.autonoma.app/v1/mcp/debug");
        expect(mcpUrls).toContain("https://api.autonoma.app/v1/mcp/onboarding");
    });
});
