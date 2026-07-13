import { describe, expect, it } from "vitest";
import { nodeBuildCommands } from "../../src/dockerfile-builder/node-package-manager";

describe("nodeBuildCommands (root/turbo)", () => {
    it("invokes the turbo binary via pnpm exec", () => {
        const c = nodeBuildCommands(
            { framework: "next", package_manager: "pnpm", node_version: "22", build_context: "root" },
            "web",
        );
        expect(c.build).toBe("pnpm exec turbo run build --filter=web");
        expect(c.run).toBe("pnpm exec turbo run start --filter=web");
        expect(c.build).not.toContain("run turbo");
    });

    it("invokes the turbo binary via yarn", () => {
        const c = nodeBuildCommands(
            { framework: "next", package_manager: "yarn", node_version: "22", build_context: "root" },
            "web",
        );
        expect(c.build).toBe("yarn turbo run build --filter=web");
        expect(c.run).toBe("yarn turbo run start --filter=web");
        expect(c.build).not.toContain("run turbo");
    });

    it("invokes the turbo binary via npm exec with arg forwarding", () => {
        const c = nodeBuildCommands(
            { framework: "next", package_manager: "npm", node_version: "22", build_context: "root" },
            "web",
        );
        expect(c.build).toBe("npm exec turbo -- run build --filter=web");
        expect(c.run).toBe("npm exec turbo -- run start --filter=web");
        expect(c.build).not.toContain("npm turbo");
        expect(c.build).not.toContain("run turbo");
    });

    it("invokes the turbo binary via bunx", () => {
        const c = nodeBuildCommands({ framework: "bun", build_context: "root" }, "web");
        expect(c.build).toBe("bunx turbo run build --filter=web");
        expect(c.run).toBe("bunx turbo run start --filter=web");
        expect(c.build).not.toContain("bun turbo");
        expect(c.build).not.toContain("run turbo");
    });

    it("lets explicit build_command / run_command overrides win", () => {
        const c = nodeBuildCommands(
            {
                framework: "next",
                package_manager: "pnpm",
                node_version: "22",
                build_context: "root",
                build_command: "make build",
                run_command: "make serve",
            },
            "web",
        );
        expect(c.build).toBe("make build");
        expect(c.run).toBe("make serve");
    });
});

describe("nodeBuildCommands (app/non-root)", () => {
    it("uses plain package-manager scripts for pnpm, no turbo", () => {
        const c = nodeBuildCommands(
            { framework: "next", package_manager: "pnpm", node_version: "22", build_context: "app" },
            "web",
        );
        expect(c.build).toBe("pnpm run build");
        expect(c.run).toBe("pnpm start");
        expect(c.build).not.toContain("turbo");
        expect(c.run).not.toContain("turbo");
    });

    it("serves vite's static preview", () => {
        const c = nodeBuildCommands(
            { framework: "vite", package_manager: "pnpm", node_version: "22", build_context: "app" },
            "web",
        );
        expect(c.build).toBe("pnpm run build");
        expect(c.run).toBe("pnpm run preview");
    });
});
