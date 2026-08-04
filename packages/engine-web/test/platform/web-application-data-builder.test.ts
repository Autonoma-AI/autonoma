import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWebApplicationData } from "../../src/platform/web-application-data-builder";

vi.mock("../../src/platform/previewkit-bypass-token", () => ({
    resolvePreviewkitBypassToken: vi.fn().mockResolvedValue(undefined),
}));

import { resolvePreviewkitBypassToken } from "../../src/platform/previewkit-bypass-token";

const mockResolveBypassToken = vi.mocked(resolvePreviewkitBypassToken);

beforeEach(() => {
    mockResolveBypassToken.mockResolvedValue(undefined);
});

describe("buildWebApplicationData", () => {
    it("returns minimal data when no auth provided and no bypass token", async () => {
        const result = await buildWebApplicationData({ url: "https://example.com" });

        expect(result).toEqual({
            url: "https://example.com",
            file: undefined,
            cookies: undefined,
            headers: undefined,
        });
    });

    it("passes file through unchanged", async () => {
        const result = await buildWebApplicationData({
            url: "https://example.com",
            file: "/tmp/upload.zip",
        });

        expect(result.file).toBe("/tmp/upload.zip");
    });

    it("converts auth cookies via toPlaywrightCookies with url fallback", async () => {
        const result = await buildWebApplicationData({
            url: "https://example.com",
            auth: {
                cookies: [{ name: "session", value: "abc123" }],
            },
        });

        expect(result.cookies).toHaveLength(1);
        expect(result.cookies![0]).toMatchObject({
            name: "session",
            value: "abc123",
            url: "https://example.com",
        });
    });

    it("converts auth cookies with domain and path when present", async () => {
        const result = await buildWebApplicationData({
            url: "https://example.com",
            auth: {
                cookies: [{ name: "token", value: "xyz", domain: "example.com", path: "/app" }],
            },
        });

        expect(result.cookies![0]).toMatchObject({
            name: "token",
            domain: "example.com",
            path: "/app",
        });
        expect(result.cookies![0]).not.toHaveProperty("url");
    });

    it("sets headers from auth.headers when no bypass token", async () => {
        const result = await buildWebApplicationData({
            url: "https://example.com",
            auth: { headers: { Authorization: "Bearer tok" } },
        });

        expect(result.headers).toEqual({ Authorization: "Bearer tok" });
    });

    it("returns undefined headers when auth has no headers and no bypass token", async () => {
        const result = await buildWebApplicationData({
            url: "https://example.com",
            auth: { cookies: [{ name: "s", value: "v" }] },
        });

        expect(result.headers).toBeUndefined();
    });

    it("merges bypass token into headers alongside auth headers", async () => {
        mockResolveBypassToken.mockResolvedValue("bypass-secret");

        const result = await buildWebApplicationData({
            url: "https://example.com",
            auth: { headers: { Authorization: "Bearer tok" } },
        });

        expect(result.headers).toEqual({
            Authorization: "Bearer tok",
            "x-previewkit-bypass": "bypass-secret",
        });
    });

    it("sets only bypass token in headers when there are no auth headers", async () => {
        mockResolveBypassToken.mockResolvedValue("bypass-secret");

        const result = await buildWebApplicationData({ url: "https://example.com" });

        expect(result.headers).toEqual({ "x-previewkit-bypass": "bypass-secret" });
    });

    it("merges customHeaders with auth headers", async () => {
        const result = await buildWebApplicationData({
            url: "https://example.com",
            auth: { headers: { Authorization: "Bearer tok" } },
            customHeaders: { "X-Custom": "value" },
        });

        expect(result.headers).toEqual({
            Authorization: "Bearer tok",
            "X-Custom": "value",
        });
    });

    it("bypass token wins over any existing x-previewkit-bypass in headers", async () => {
        mockResolveBypassToken.mockResolvedValue("new-token");

        const result = await buildWebApplicationData({
            url: "https://example.com",
            auth: { headers: { "x-previewkit-bypass": "old" } },
        });

        expect(result.headers!["x-previewkit-bypass"]).toBe("new-token");
    });

    it("returns undefined headers when all header sources are empty and no bypass token", async () => {
        const result = await buildWebApplicationData({
            url: "https://example.com",
            auth: { headers: {} },
            customHeaders: {},
        });

        expect(result.headers).toBeUndefined();
    });

    it("resolves bypass token for the provided url", async () => {
        await buildWebApplicationData({ url: "https://app.example.com" });

        expect(mockResolveBypassToken).toHaveBeenCalledWith("https://app.example.com");
    });

    it("handles auth with cookies, headers, and bypass token together", async () => {
        mockResolveBypassToken.mockResolvedValue("bypass");

        const result = await buildWebApplicationData({
            url: "https://app.example.com",
            file: "/tmp/file.zip",
            auth: {
                cookies: [{ name: "sid", value: "secret", domain: "app.example.com" }],
                headers: { "X-Tenant": "acme" },
            },
        });

        expect(result.url).toBe("https://app.example.com");
        expect(result.file).toBe("/tmp/file.zip");
        expect(result.cookies).toHaveLength(1);
        expect(result.headers).toEqual({
            "X-Tenant": "acme",
            "x-previewkit-bypass": "bypass",
        });
    });
});
