import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { resolveConfig } from "../../src/config/resolver";

const baseDocument = {
    version: 1,
    apps: [{ name: "web", port: 3000 }],
    services: [{ name: "db", recipe: "postgres" }],
};

describe("resolveConfig", () => {
    it("validates and returns a PreviewConfig from a document", () => {
        const config = resolveConfig({ document: baseDocument });
        expect(config.apps[0].name).toBe("web");
        expect(config.services[0].recipe).toBe("postgres");
    });

    it("ignores explicit resource values from the config document", () => {
        const config = resolveConfig({
            document: {
                version: 1,
                apps: [{ name: "web", port: 3000, resources: { cpu: "4", memory: "8Gi" } }],
            },
        });
        expect(config.apps[0].resources).toEqual({ cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" });
    });

    it("throws ZodError for an invalid document", () => {
        expect(() => resolveConfig({ document: { version: 1, apps: [] } })).toThrow(ZodError);
    });

    it("treats an unset schemaVersion as the current version (no upgrade)", () => {
        const config = resolveConfig({ document: baseDocument });
        expect(config.apps).toHaveLength(1);
    });

    it("rejects a document written against a newer schemaVersion", () => {
        expect(() => resolveConfig({ document: baseDocument, schemaVersion: 99 })).toThrow(/newer than this build/);
    });

    it("rejects an unsupported older schemaVersion (no upgrader yet)", () => {
        expect(() => resolveConfig({ document: baseDocument, schemaVersion: 0 })).toThrow(/No upgrader/);
    });
});
