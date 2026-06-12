import { describe, it, expect } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import { computeDeployWaves } from "../../src/pipeline/deploy-graph.js";

function app(name: string, depends_on?: string[]): AppConfig {
    return {
        name,
        path: ".",
        port: 3000,
        env: {},
        build_args: {},
        replicas: 1,
        resources: { cpu: "250m", memoryRequest: "256Mi", memoryLimit: "512Mi" },
        depends_on,
    };
}

describe("computeDeployWaves", () => {
    it("returns an empty array for no apps", () => {
        expect(computeDeployWaves([])).toEqual([]);
    });

    it("puts a single app with no dependencies in wave 0", () => {
        const waves = computeDeployWaves([app("web")]);
        expect(waves).toHaveLength(1);
        expect(waves[0]!.map((a) => a.name)).toEqual(["web"]);
    });

    it("puts independent apps in the same wave", () => {
        const waves = computeDeployWaves([app("web"), app("api"), app("worker")]);
        expect(waves).toHaveLength(1);
        expect(waves[0]!.map((a) => a.name)).toEqual(expect.arrayContaining(["web", "api", "worker"]));
    });

    it("orders a linear chain across waves", () => {
        // payments → users → web
        const waves = computeDeployWaves([app("web", ["users"]), app("users", ["payments"]), app("payments")]);
        expect(waves).toHaveLength(3);
        expect(waves[0]!.map((a) => a.name)).toEqual(["payments"]);
        expect(waves[1]!.map((a) => a.name)).toEqual(["users"]);
        expect(waves[2]!.map((a) => a.name)).toEqual(["web"]);
    });

    it("groups apps with the same dependency level into the same wave", () => {
        // api and worker both depend only on db; web depends on api and worker
        const waves = computeDeployWaves([
            app("web", ["api", "worker"]),
            app("api", ["db"]),
            app("worker", ["db"]),
            app("db"),
        ]);
        expect(waves).toHaveLength(3);
        expect(waves[0]!.map((a) => a.name)).toEqual(["db"]);
        expect(waves[1]!.map((a) => a.name)).toEqual(expect.arrayContaining(["api", "worker"]));
        expect(waves[2]!.map((a) => a.name)).toEqual(["web"]);
    });

    it("treats an empty depends_on the same as no depends_on", () => {
        const waves = computeDeployWaves([app("web", [])]);
        expect(waves).toHaveLength(1);
        expect(waves[0]!.map((a) => a.name)).toEqual(["web"]);
    });

    it("throws for an unknown depends_on reference", () => {
        expect(() => computeDeployWaves([app("web", ["missing"])])).toThrow(
            `App "web" has unknown depends_on "missing"`,
        );
    });

    it("throws for a direct circular dependency", () => {
        expect(() => computeDeployWaves([app("a", ["b"]), app("b", ["a"])])).toThrow("Circular dependency detected");
    });

    it("throws for an indirect circular dependency", () => {
        expect(() => computeDeployWaves([app("a", ["c"]), app("b", ["a"]), app("c", ["b"])])).toThrow(
            "Circular dependency detected",
        );
    });
});
