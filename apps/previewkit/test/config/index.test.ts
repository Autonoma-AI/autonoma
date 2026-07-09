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

    it("exposes the tiered standard resources as platform policy", () => {
        const d = createPreviewkitDefaults(env);
        expect(d.standards.resources).toEqual({
            app: { cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" },
            service: { cpu: "100m", memoryRequest: "256Mi", memoryLimit: "1Gi" },
        });
        // Same canonical values the schema transforms apply.
        expect(d.standards.resources.app).toEqual(STANDARD_RESOURCES.app);
        expect(d.standards.resources.service).toEqual(STANDARD_RESOURCES.service);
    });
});
