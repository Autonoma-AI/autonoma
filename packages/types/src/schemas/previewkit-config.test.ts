import { describe, expect, it } from "vitest";
import {
    connectionTargets,
    connectionTokens,
    previewConfigSchema,
    validatePreviewConfigSemantics,
    validateHookSteps,
} from "./previewkit-config";

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

    it("accepts a dockerfile framework with a target stage", () => {
        const result = parseWithBuild({ framework: "dockerfile", dockerfile: "./Dockerfile", target: "production" });
        expect(result.success).toBe(true);
        if (result.success) {
            const build = result.data.apps[0]?.build;
            expect(build).toEqual({
                framework: "dockerfile",
                dockerfile: "./Dockerfile",
                target: "production",
                build_context: "app",
            });
        }
    });

    it("rejects an empty target stage", () => {
        expect(parseWithBuild({ framework: "dockerfile", dockerfile: "./Dockerfile", target: "" }).success).toBe(false);
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

    it("parses an app with no build block (bare-Dockerfile path)", () => {
        const result = previewConfigSchema.safeParse({ version: 1, apps: [{ name: "web", port: 3000 }] });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.apps[0]?.build).toBeUndefined();
        }
    });
});

describe("previewConfigSchema runtime build block", () => {
    it("accepts a minimal runtime build with a required entrypoint", () => {
        const result = parseWithBuild({ framework: "runtime", runtime: "node", entrypoint: "npm start" });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.apps[0]?.build).toEqual({
                framework: "runtime",
                runtime: "node",
                entrypoint: "npm start",
                build_context: "app",
            });
        }
    });

    it("rejects an unknown runtime (alpine was removed)", () => {
        expect(parseWithBuild({ framework: "runtime", runtime: "alpine", entrypoint: "./start.sh" }).success).toBe(
            false,
        );
    });

    it("requires an entrypoint", () => {
        expect(parseWithBuild({ framework: "runtime", runtime: "node" }).success).toBe(false);
    });

    it("rejects an entrypoint with a line break (Dockerfile CMD injection)", () => {
        expect(
            parseWithBuild({ framework: "runtime", runtime: "node", entrypoint: "npm start\nnode server.js" }).success,
        ).toBe(false);
    });

    it("rejects a build_script line equal to the reserved heredoc delimiter", () => {
        const result = parseWithBuild({
            framework: "runtime",
            runtime: "node",
            entrypoint: "npm start",
            build_script: "echo hi\nAUTONOMA_BUILD_EOF\nrm -rf /",
        });
        expect(result.success).toBe(false);
    });

    it("accepts a multi-line build_script that never hits the delimiter", () => {
        expect(
            parseWithBuild({
                framework: "runtime",
                runtime: "python",
                entrypoint: "python main.py",
                build_script: "uv sync\nuv run build",
            }).success,
        ).toBe(true);
    });

    it("rejects a version tag outside the safe charset", () => {
        expect(
            parseWithBuild({ framework: "runtime", runtime: "node", version: "20 && rm", entrypoint: "npm start" })
                .success,
        ).toBe(false);
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

describe("connection token parsing", () => {
    it("extracts every {{name.property}} token from a composite value", () => {
        const value = "mongodb://{{db.host}}:{{db.port}}/preview?x={{cache.host}}";
        expect(connectionTokens(value)).toEqual([
            { target: "db", property: "host" },
            { target: "db", property: "port" },
            { target: "cache", property: "host" },
        ]);
        expect(connectionTargets(value)).toEqual(["db", "cache"]);
    });

    it("ignores single-word builtins with no dot ({{pr}})", () => {
        expect(connectionTokens("https://{{pr}}.example.com/{{api.url}}")).toEqual([
            { target: "api", property: "url" },
        ]);
    });
});

describe("connection validation", () => {
    const parse = (connections: unknown) =>
        previewConfigSchema.parse({
            version: 1,
            apps: [{ name: "web", port: 3000, connections }],
            services: [{ name: "db", recipe: "postgres" }],
        });

    it("accepts a single-token connection to a declared service", () => {
        const config = parse([{ key: "DATABASE_URL", value: "{{db.url}}" }]);
        const issues = validatePreviewConfigSemantics(config);
        expect(issues.some((issue) => issue.path.includes("connections"))).toBe(false);
        expect(config.apps[0]?.connections[0]?.build_time).toBe(false);
    });

    it("accepts a composite connection value combining multiple tokens and literal text", () => {
        const config = parse([{ key: "MONGO_URI", value: "mongodb://{{db.host}}:{{db.port}}/preview?replicaSet=rs0" }]);
        const issues = validatePreviewConfigSemantics(config);
        expect(issues.some((issue) => issue.path.includes("connections"))).toBe(false);
    });

    it("flags a connection referencing an unknown app or service", () => {
        const config = parse([{ key: "MONGO_URI", value: "mongodb://{{ghost.host}}:{{db.port}}/x" }]);
        const issues = validatePreviewConfigSemantics(config);
        expect(issues.some((issue) => issue.code === "unknown_connection_target")).toBe(true);
    });

    it("flags two connections sharing a key", () => {
        const config = parse([
            { key: "URL", value: "{{db.host}}" },
            { key: "URL", value: "{{db.port}}" },
        ]);
        const issues = validatePreviewConfigSemantics(config);
        expect(issues.some((issue) => issue.code === "duplicate_connection_key")).toBe(true);
    });

    it("warns when a database service is not referenced by any app connection", () => {
        const config = parse([{ key: "NODE_ENV", value: "production" }]);
        const issues = validatePreviewConfigSemantics(config);
        const warning = issues.find((issue) => issue.code === "unreferenced_database_service");
        expect(warning?.severity).toBe("warning");
        expect(warning?.path).toEqual(["services", 0]);
        expect(warning?.message).toContain("{{db.url}}");
    });

    it("does not warn about a database service some app connects to", () => {
        const config = parse([{ key: "DATABASE_URL", value: "postgresql://preview:preview@{{db.host}}:5432/preview" }]);
        const issues = validatePreviewConfigSemantics(config);
        expect(issues.some((issue) => issue.code === "unreferenced_database_service")).toBe(false);
    });

    it("does not warn about non-database services without connections", () => {
        const config = previewConfigSchema.parse({
            version: 1,
            apps: [{ name: "web", port: 3000 }],
            services: [{ name: "flow", recipe: "temporal" }],
        });
        const issues = validatePreviewConfigSemantics(config);
        expect(issues.some((issue) => issue.code === "unreferenced_database_service")).toBe(false);
    });

    it("rejects a reserved key as a connection", () => {
        const result = previewConfigSchema.safeParse({
            version: 1,
            apps: [{ name: "web", port: 3000, connections: [{ key: "AUTONOMA_PREVIEWKIT", value: "{{db.url}}" }] }],
            services: [{ name: "db", recipe: "postgres" }],
        });
        expect(result.success).toBe(false);
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
