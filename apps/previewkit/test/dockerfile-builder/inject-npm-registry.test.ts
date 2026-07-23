import { describe, expect, it } from "vitest";
import { injectNpmRegistryMirror } from "../../src/dockerfile-builder/inject-npm-registry";

const MIRROR = "http://verdaccio.buildkit.svc.cluster.local:4873/";

describe("injectNpmRegistryMirror", () => {
    it("returns the content unchanged when the mirror is disabled", () => {
        const dockerfile = "FROM node:22-bookworm-slim\nRUN npm ci\n";
        expect(injectNpmRegistryMirror(dockerfile, "")).toBe(dockerfile);
    });

    it("injects the ENV lines after a single-stage FROM", () => {
        const dockerfile = "FROM node:22-bookworm-slim\nWORKDIR /app\nRUN npm ci\n";
        const result = injectNpmRegistryMirror(dockerfile, MIRROR);
        const lines = result.split("\n");
        expect(lines[0]).toBe("FROM node:22-bookworm-slim");
        expect(lines[1]).toBe(`ENV npm_config_registry="${MIRROR}" \\`);
        expect(lines[2]).toBe(`    BUN_CONFIG_REGISTRY="${MIRROR}"`);
        expect(lines[3]).toBe("WORKDIR /app");
        expect(result.indexOf("npm_config_registry")).toBeLessThan(result.indexOf("RUN npm ci"));
    });

    it("injects after every FROM in a multi-stage Dockerfile, since ENV does not carry across stages", () => {
        const dockerfile = [
            "FROM node:22-bookworm-slim AS deps",
            "RUN npm ci",
            "FROM node:22-bookworm-slim AS runner",
            "COPY --from=deps /app/node_modules ./node_modules",
        ].join("\n");
        const result = injectNpmRegistryMirror(dockerfile, MIRROR);
        expect(result.match(/npm_config_registry/g)).toHaveLength(2);
        // Each injection lands immediately after its own FROM, not just the first.
        expect(result.indexOf("npm_config_registry", result.indexOf("AS runner"))).toBeGreaterThan(
            result.indexOf("AS runner"),
        );
    });

    it("is a default, not an override: a later ENV in the same stage still wins", () => {
        const dockerfile = [
            "FROM node:22-bookworm-slim",
            'ENV npm_config_registry="https://registry.mycompany.internal/"',
            "RUN npm ci",
        ].join("\n");
        const result = injectNpmRegistryMirror(dockerfile, MIRROR);
        const lastRegistryLine = result
            .split("\n")
            .filter((line) => line.includes("npm_config_registry"))
            .pop();
        expect(lastRegistryLine).toContain("registry.mycompany.internal");
    });

    it("ignores FROM-like text in comments", () => {
        const dockerfile = "# FROM this comment does not count\nFROM node:22-bookworm-slim\n";
        const result = injectNpmRegistryMirror(dockerfile, MIRROR);
        expect(result.match(/npm_config_registry/g)).toHaveLength(1);
    });
});
