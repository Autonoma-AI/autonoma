import { describe, expect, it } from "vitest";
import { previewConfigSchema, validateHookSteps } from "./previewkit-config";

function parseWithBuild(build: unknown) {
    return previewConfigSchema.safeParse({
        version: 1,
        apps: [{ name: "web", port: 3000, build }],
    });
}

describe("previewConfigSchema build block", () => {
    it("defaults package_manager, node_version, and build_context for a node framework", () => {
        const result = parseWithBuild({ framework: "node" });
        expect(result.success).toBe(true);
        if (result.success) {
            const build = result.data.apps[0]?.build;
            expect(build).toEqual({
                framework: "node",
                package_manager: "pnpm",
                node_version: "22",
                build_context: "app",
            });
        }
    });

    it.each(["node", "next", "vite"])("accepts the %s framework", (framework) => {
        expect(parseWithBuild({ framework }).success).toBe(true);
    });

    it("accepts the bun framework without package_manager or node_version", () => {
        const result = parseWithBuild({ framework: "bun", build_context: "root" });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.apps[0]?.build).toEqual({ framework: "bun", build_context: "root" });
        }
    });

    it("accepts a dockerfile framework with a path", () => {
        expect(parseWithBuild({ framework: "dockerfile", dockerfile: "./Dockerfile" }).success).toBe(true);
    });

    it("rejects a dockerfile framework without a path", () => {
        expect(parseWithBuild({ framework: "dockerfile" }).success).toBe(false);
    });

    it("rejects an unknown framework", () => {
        expect(parseWithBuild({ framework: "svelte" }).success).toBe(false);
    });

    it("rejects an unknown package_manager", () => {
        expect(parseWithBuild({ framework: "node", package_manager: "bun" }).success).toBe(false);
    });

    it.each(["22", "22.5", "22.5.0"])("accepts node_version %s", (node_version) => {
        expect(parseWithBuild({ framework: "node", node_version }).success).toBe(true);
    });

    it.each(["latest", "v22", "22.x", ""])("rejects node_version %s", (node_version) => {
        expect(parseWithBuild({ framework: "node", node_version }).success).toBe(false);
    });

    it("rejects an invalid build_context", () => {
        expect(parseWithBuild({ framework: "node", build_context: "repo" }).success).toBe(false);
    });

    it("parses an app with no build block (Railpack fallback)", () => {
        const result = previewConfigSchema.safeParse({ version: 1, apps: [{ name: "web", port: 3000 }] });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.apps[0]?.build).toBeUndefined();
        }
    });
});

describe("previewConfigSchema multirepo dependency sha", () => {
    function parseWithRepos(repos: unknown) {
        return previewConfigSchema.safeParse({
            version: 1,
            apps: [{ name: "web", port: 3000 }],
            config: { multirepo: { repos } },
        });
    }

    it("defaults the dependency sha to undefined in authored config", () => {
        const result = parseWithRepos([{ name: "api", repo: "acme/api" }]);
        expect(result.success).toBe(true);
        if (result.success) {
            const dep = result.data.config?.multirepo?.repos[0];
            expect(dep?.fallback_branch).toBe("main");
            expect(dep?.sha).toBeUndefined();
        }
    });

    // The deploy-time enrichment writes `sha` back into resolvedConfig; readers
    // re-parse that JSON, so the field must survive parsing (Zod strips unknown
    // keys, so an absent schema field would silently drop the recorded SHA).
    it("preserves a recorded dependency sha through parsing", () => {
        const result = parseWithRepos([{ name: "api", repo: "acme/api", sha: "abc123def456" }]);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.config?.multirepo?.repos[0]?.sha).toBe("abc123def456");
        }
    });
});

describe("validateHookSteps", () => {
    const appNames = new Set(["api", "web"]);

    it("accepts a valid hook", () => {
        const issues = validateHookSteps(
            [{ app: "api", command: "npx prisma migrate deploy" }],
            appNames,
            "post_deploy",
        );
        expect(issues).toEqual([]);
    });

    it("ignores a fully-blank row", () => {
        const issues = validateHookSteps([{ app: "  ", command: "" }], appNames, "post_deploy");
        expect(issues).toEqual([]);
    });

    it("flags a missing app", () => {
        const issues = validateHookSteps([{ app: "", command: "echo hi" }], appNames, "pre_deploy");
        expect(issues).toEqual([
            {
                severity: "error",
                code: "empty_hook_app",
                path: ["hooks", "pre_deploy", 0, "app"],
                message: "Hook is missing an app",
            },
        ]);
    });

    it("flags an unknown app", () => {
        const issues = validateHookSteps([{ app: "worker", command: "echo hi" }], appNames, "post_deploy");
        expect(issues).toEqual([
            {
                severity: "error",
                code: "unknown_hook_app",
                path: ["hooks", "post_deploy", 0, "app"],
                message: 'Hook references unknown app "worker"',
            },
        ]);
    });

    it("flags a missing command", () => {
        const issues = validateHookSteps([{ app: "api", command: "   " }], appNames, "post_deploy");
        expect(issues).toEqual([
            {
                severity: "error",
                code: "empty_hook_command",
                path: ["hooks", "post_deploy", 0, "command"],
                message: "Hook is missing a command",
            },
        ]);
    });

    it("flags both a missing app and a missing command on the same row", () => {
        const issues = validateHookSteps(
            [
                { app: "", command: "deploy" },
                { app: "api", command: "" },
            ],
            appNames,
            "pre_deploy",
        );
        expect(issues.map((issue) => issue.code)).toEqual(["empty_hook_app", "empty_hook_command"]);
    });
});
