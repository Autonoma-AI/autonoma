import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config/schema";
import { resolvePrimaryUrl } from "../../src/diffs/resolve-primary-url";

const makeApp = (name: string, primary?: boolean): AppConfig => ({
    name,
    repository: "acme/web",
    path: ".",
    port: 3000,
    build_secrets: [],
    connections: [],
    primary,
    resources: { cpu: "250m", memoryRequest: "256Mi", memoryLimit: "512Mi" },
});

describe("resolvePrimaryUrl", () => {
    it("returns the URL of the app marked primary: true", () => {
        const apps = [makeApp("api"), makeApp("web", true)];
        const urls = { api: "https://api.preview.example.com", web: "https://web.preview.example.com" };
        expect(resolvePrimaryUrl(apps, urls)).toBe("https://web.preview.example.com");
    });

    it("falls back to apps[0] when no app has primary: true", () => {
        const apps = [makeApp("api"), makeApp("web")];
        const urls = { api: "https://api.preview.example.com", web: "https://web.preview.example.com" };
        expect(resolvePrimaryUrl(apps, urls)).toBe("https://api.preview.example.com");
    });

    it("returns undefined when the primary app name is not in urls", () => {
        const apps = [makeApp("web", true)];
        const urls = { api: "https://api.preview.example.com" };
        expect(resolvePrimaryUrl(apps, urls)).toBeUndefined();
    });

    it("falls back to apps[0] when all apps have primary: false", () => {
        const apps = [makeApp("api", false), makeApp("web", false)];
        const urls = { api: "https://api.preview.example.com", web: "https://web.preview.example.com" };
        expect(resolvePrimaryUrl(apps, urls)).toBe("https://api.preview.example.com");
    });
});
