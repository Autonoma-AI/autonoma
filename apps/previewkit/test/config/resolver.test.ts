import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { resolveConfig } from "../../src/config/resolver";

const baseDocument = {
    version: 2,
    apps: [{ name: "web", repository: "acme/web", port: 3000 }],
    services: [{ name: "db", recipe: "postgres" }],
};

describe("resolveConfig", () => {
    it("validates and returns a PreviewConfig from a document", () => {
        const config = resolveConfig({ document: baseDocument });
        expect(config.apps[0].name).toBe("web");
        expect(config.apps[0].repository).toBe("acme/web");
        expect(config.services[0].recipe).toBe("postgres");
    });

    it("ignores explicit resource values from the config document", () => {
        const config = resolveConfig({
            document: {
                version: 2,
                apps: [{ name: "web", repository: "acme/web", port: 3000, resources: { cpu: "4", memory: "8Gi" } }],
            },
        });
        expect(config.apps[0].resources).toEqual({ tier: "medium", cpu: "250m", memory: "1Gi" });
    });

    it("throws ZodError for an invalid document", () => {
        expect(() => resolveConfig({ document: { version: 2, apps: [] } })).toThrow(ZodError);
    });

    it("strips retired inline env/build_args and defaults their replacements", () => {
        const config = resolveConfig({
            document: {
                version: 2,
                apps: [
                    {
                        name: "web",
                        repository: "acme/web",
                        port: 3000,
                        env: { FOO: "bar" },
                        build_args: { BAZ: "qux" },
                    },
                ],
            },
        });
        expect(config.apps[0].name).toBe("web");
        expect(config.apps[0].connections).toEqual([]);
        expect(config.apps[0].build_secrets).toEqual([]);
    });
});
