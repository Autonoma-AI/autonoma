import { describe, expect, it } from "vitest";
import { createPreviewkitDefaults, STANDARD_RESOURCES } from "../../src/config";

describe("createPreviewkitDefaults", () => {
    const env = {
        REGISTRY_URL: "registry.example.com:5000",
        PREVIEW_DOMAIN: "preview.example.com",
        BUILD_TIMEOUT_MS: 1_800_000,
    };

    it("sources overridable defaults from env", () => {
        const d = createPreviewkitDefaults(env);
        expect(d.defaults).toEqual({
            registry: "registry.example.com:5000",
            domain: "preview.example.com",
            buildTimeoutMs: 1_800_000,
        });
    });

    it("exposes the standard resources as platform policy", () => {
        const d = createPreviewkitDefaults(env);
        expect(d.standards.resources).toEqual({ cpu: "1000m", memory: "1Gi" });
        // Same canonical values the schema transform applies.
        expect(d.standards.resources).toEqual({ cpu: STANDARD_RESOURCES.cpu, memory: STANDARD_RESOURCES.memory });
    });
});
