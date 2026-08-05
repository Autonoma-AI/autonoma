import { describe, expect, test } from "vitest";
import { resolveApiUrl, resolveMcpUrl } from "../../src/core/api-url";

describe("resolveApiUrl", () => {
    test("defaults to production and strips a trailing slash", () => {
        expect(resolveApiUrl()).toBe("https://autonoma.app");
        expect(resolveApiUrl("https://alpha.example.test/")).toBe("https://alpha.example.test");
    });
});

describe("resolveMcpUrl", () => {
    // Production only. autonoma.app is behind CloudFront, whose buffering interferes
    // with the MCP's streaming HTTP, and the API advertises the api. origin as its
    // OAuth protected resource - a strict client's check only passes there.
    test("points production at the api host, not the app host", () => {
        expect(resolveMcpUrl("https://autonoma.app")).toBe("https://api.autonoma.app/v1/mcp");
    });

    // An override already names an API directly; prefixing it would invent a
    // hostname that does not resolve.
    test("leaves an override alone", () => {
        expect(resolveMcpUrl("https://alpha.example.test")).toBe("https://alpha.example.test/v1/mcp");
        expect(resolveMcpUrl("http://localhost:4000")).toBe("http://localhost:4000/v1/mcp");
        expect(resolveMcpUrl("https://api.autonoma.app")).toBe("https://api.autonoma.app/v1/mcp");
    });

    test("tolerates a trailing slash on either path", () => {
        expect(resolveMcpUrl("https://autonoma.app/")).toBe("https://api.autonoma.app/v1/mcp");
        expect(resolveMcpUrl("http://localhost:4000/")).toBe("http://localhost:4000/v1/mcp");
    });
});
