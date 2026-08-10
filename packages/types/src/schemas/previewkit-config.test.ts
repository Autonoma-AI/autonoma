import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    authoringPreviewConfigSchema,
    type BlueprintFacts,
    blueprintToBuild,
    connectionTargets,
    declaredSdkPath,
    sdkPathFromDocument,
    connectionTokens,
    DEPRECATED_BUILD_FRAMEWORKS,
    previewConfigSchema,
    topologyRepositories,
    validatePreviewConfigSemantics,
    validateHookSteps,
} from "./previewkit-config";

/** The facts of a standalone app-context build: plain npm repo, no lockfile. */
const APP_FACTS: BlueprintFacts = { packageManager: "npm", hasLockfile: false, appPath: "." };

function parseWithBuild(build: unknown) {
    return previewConfigSchema.safeParse({
        version: 2,
        apps: [{ name: "web", repository: "acme/web", port: 3000, build }],
    });
}

function parseWithBlueprint(blueprint: unknown) {
    return previewConfigSchema.safeParse({
        version: 2,
        apps: [{ name: "web", repository: "acme/web", port: 3000, blueprint }],
    });
}

describe("previewConfigSchema blueprint block", () => {
    it("accepts a blueprint selecting a preset", () => {
        const result = parseWithBlueprint({ preset: "nextjs" });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.apps[0]?.blueprint).toMatchObject({ preset: "nextjs" });
        }
    });

    it("accepts per-app overrides", () => {
        expect(parseWithBlueprint({ preset: "django", version: "3.13", run_command: "gunicorn app:app" }).success).toBe(
            true,
        );
    });

    it("rejects an unknown preset", () => {
        expect(parseWithBlueprint({ preset: "svelte" }).success).toBe(false);
    });

    it("rejects an app that sets both build and blueprint", () => {
        const result = previewConfigSchema.safeParse({
            version: 2,
            apps: [
                {
                    name: "web",
                    repository: "acme/web",
                    port: 3000,
                    build: { framework: "node" },
                    blueprint: { preset: "node" },
                },
            ],
        });
        expect(result.success).toBe(false);
    });

    it("rejects a run_command with a line break (CMD injection)", () => {
        expect(parseWithBlueprint({ preset: "node", run_command: "npm start\nRUN rm -rf /" }).success).toBe(false);
    });

    it("rejects an output_directory with a line break (static-serve CMD injection)", () => {
        expect(parseWithBlueprint({ preset: "vite", output_directory: "dist\nRUN evil" }).success).toBe(false);
    });

    it("rejects an install_command line equal to the reserved heredoc delimiter", () => {
        expect(
            parseWithBlueprint({ preset: "node", install_command: "npm ci\nAUTONOMA_BUILD_EOF\nrm -rf /" }).success,
        ).toBe(false);
    });

    it("rejects a build_command line equal to the reserved heredoc delimiter", () => {
        expect(parseWithBlueprint({ preset: "node", build_command: "make\nAUTONOMA_BUILD_EOF" }).success).toBe(false);
    });

    it("accepts a bring-your-own dockerfile blueprint", () => {
        const result = parseWithBlueprint({ dockerfile: "./Dockerfile" });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.apps[0]?.blueprint).toEqual({ dockerfile: "./Dockerfile" });
        }
    });

    it("accepts a dockerfile blueprint with a target stage", () => {
        expect(parseWithBlueprint({ dockerfile: "./Dockerfile", target: "prod" }).success).toBe(true);
    });

    it("rejects a dockerfile blueprint with an empty path", () => {
        expect(parseWithBlueprint({ dockerfile: "" }).success).toBe(false);
    });

    it("rejects a blueprint that mixes preset and dockerfile", () => {
        expect(parseWithBlueprint({ preset: "node", dockerfile: "./Dockerfile" }).success).toBe(false);
    });

    it("accepts build_context root on a node preset (monorepo)", () => {
        expect(parseWithBlueprint({ preset: "nextjs", build_context: "root" }).success).toBe(true);
    });

    it("accepts build_context root on a dockerfile blueprint", () => {
        expect(parseWithBlueprint({ dockerfile: "apps/web/Dockerfile", build_context: "root" }).success).toBe(true);
    });

    it("accepts build_context root on a non-node preset (uniform monorepo axis)", () => {
        expect(parseWithBlueprint({ preset: "django", build_context: "root" }).success).toBe(true);
    });

    it("rejects a non-numeric version for a node preset (an un-pullable node tag)", () => {
        // node:<version>-bookworm-slim - "20-alpine" would render node:20-alpine-bookworm-slim.
        expect(parseWithBlueprint({ preset: "nextjs", version: "20-alpine" }).success).toBe(false);
        expect(parseWithBlueprint({ preset: "nextjs", version: "22-slim", build_context: "root" }).success).toBe(false);
    });

    it("accepts a bare node version for a node preset", () => {
        expect(parseWithBlueprint({ preset: "nextjs", version: "22.5" }).success).toBe(true);
    });
});

// blueprintToBuild returns a runtime | dockerfile Build; the preset cases below all
// lower to runtime, so narrow to expose the runtime-only fields (entrypoint, build_script).
function lowerToRuntime(
    blueprint: Parameters<typeof blueprintToBuild>[0],
    port: number,
    facts: BlueprintFacts = APP_FACTS,
) {
    const build = blueprintToBuild(blueprint, port, facts);
    if (build.framework !== "runtime") throw new Error(`expected a runtime build, got ${build.framework}`);
    return build;
}

describe("blueprintToBuild", () => {
    it("lowers a node preset to a runtime build with an npm-prefixed script", () => {
        const build = lowerToRuntime({ preset: "nextjs" }, 3000);
        expect(build).toMatchObject({ framework: "runtime", runtime: "node", entrypoint: "npm run start" });
        expect(build.build_script).toContain("npm install");
        expect(build.build_script).toContain("npm run build");
    });

    it("lowers a python preset to a runtime build (uv install, no npm prefix)", () => {
        const build = lowerToRuntime({ preset: "django" }, 8000);
        expect(build).toMatchObject({ framework: "runtime", runtime: "python" });
        expect(build.build_script).toContain("uv sync");
        expect(build.entrypoint).toContain("manage.py runserver");
    });

    it("lowers a static preset to an in-image static file server", () => {
        const build = lowerToRuntime({ preset: "vite" }, 80);
        expect(build.runtime).toBe("node");
        expect(build.entrypoint).toBe("npx --yes serve dist -s -l 80");
    });

    it("lowers a JS Express API to an install-only runtime build (no build step)", () => {
        const build = lowerToRuntime({ preset: "express" }, 3000);
        expect(build).toMatchObject({ framework: "runtime", runtime: "node", entrypoint: "npm run start" });
        expect(build.build_script).toBe("npm install");
    });

    it("honors command/version overrides", () => {
        const build = lowerToRuntime(
            { preset: "node", version: "20", build_command: "make", run_command: "node server.js" },
            3000,
        );
        expect(build.version).toBe("20");
        expect(build.entrypoint).toBe("node server.js");
        expect(build.build_script).toContain("make");
    });

    it("lowers a dockerfile blueprint to a dockerfile build, used as-is", () => {
        const build = blueprintToBuild({ dockerfile: "./Dockerfile", target: "prod" }, 3000, APP_FACTS);
        expect(build).toEqual({
            framework: "dockerfile",
            dockerfile: "./Dockerfile",
            target: "prod",
            build_context: "app",
        });
    });

    it("carries a dockerfile blueprint's root context into the dockerfile build", () => {
        const facts: BlueprintFacts = { packageManager: "npm", hasLockfile: false, appPath: "apps/web" };
        const build = blueprintToBuild({ dockerfile: "./Dockerfile", build_context: "root" }, 3000, facts);
        expect(build).toEqual({
            framework: "dockerfile",
            dockerfile: "./Dockerfile",
            build_context: "root",
        });
    });

    it("uses the detected package manager for an app-context node build", () => {
        const facts: BlueprintFacts = { packageManager: "pnpm", hasLockfile: true, appPath: "." };
        const build = lowerToRuntime({ preset: "nextjs" }, 3000, facts);
        expect(build.build_script).toBe("corepack enable\npnpm install --frozen-lockfile\npnpm run build");
        expect(build.entrypoint).toBe("pnpm run start");
    });

    it("builds a root node build through turbo when the repo has turbo", () => {
        const facts: BlueprintFacts = {
            packageManager: "pnpm",
            hasLockfile: true,
            appPath: "apps/web",
            turboFilter: "--filter=@acme/web",
        };
        const build = lowerToRuntime({ preset: "nextjs", build_context: "root" }, 3000, facts);
        expect(build.build_context).toBe("root");
        expect(build.build_script).toBe(
            "corepack enable\npnpm install --frozen-lockfile\npnpm exec turbo run build --filter=@acme/web",
        );
        expect(build.entrypoint).toBe("pnpm run start");
    });

    it("cd-scopes a root node build without turbo (root install, app-dir build)", () => {
        const facts: BlueprintFacts = { packageManager: "npm", hasLockfile: true, appPath: "apps/web" };
        const build = lowerToRuntime({ preset: "node", build_context: "root" }, 3000, facts);
        expect(build.build_script).toBe("npm ci\ncd apps/web\nnpm run build");
    });

    it("cd-scopes a non-node root build into the app dir", () => {
        const facts: BlueprintFacts = { packageManager: "npm", hasLockfile: false, appPath: "apps/api" };
        const build = lowerToRuntime({ preset: "django", build_context: "root" }, 8000, facts);
        expect(build).toMatchObject({ framework: "runtime", runtime: "python", build_context: "root" });
        expect(build.build_script).toBe("cd apps/api\nuv sync");
        expect(build.entrypoint).toContain("manage.py runserver");
    });

    it("cd-scopes an overridden build_command in a root build instead of turbo", () => {
        const facts: BlueprintFacts = {
            packageManager: "pnpm",
            hasLockfile: true,
            appPath: "apps/web",
            turboFilter: "--filter=@acme/web",
        };
        const build = lowerToRuntime(
            { preset: "nextjs", build_context: "root", build_command: "run build:preview" },
            3000,
            facts,
        );
        expect(build.build_script).toBe(
            "corepack enable\npnpm install --frozen-lockfile\ncd apps/web\npnpm run build:preview",
        );
    });
});

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
        const result = previewConfigSchema.safeParse({
            version: 2,
            apps: [{ name: "web", repository: "acme/web", port: 3000 }],
        });
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

describe("authoringPreviewConfigSchema build block", () => {
    function authorWithBuild(build: unknown) {
        return authoringPreviewConfigSchema.safeParse({
            version: 2,
            apps: [{ name: "web", repository: "acme/web", port: 3000, build }],
        });
    }

    it.each(DEPRECATED_BUILD_FRAMEWORKS)("rejects the retired %s preset", (framework) => {
        const result = authorWithBuild({ framework, package_manager: "pnpm", node_version: "22" });
        expect(result.success).toBe(false);
        if (!result.success) {
            // The default "no matching discriminator" message leaves an agent with no
            // way forward, so the error has to name the two methods it can use.
            expect(result.error.issues[0]?.message).toContain('"runtime"');
            expect(result.error.issues[0]?.message).toContain('"dockerfile"');
        }
    });

    it.each(DEPRECATED_BUILD_FRAMEWORKS)("still reads a stored %s preset", (framework) => {
        expect(parseWithBuild({ framework }).success).toBe(true);
    });

    it("accepts the two authorable methods", () => {
        expect(authorWithBuild({ framework: "runtime", runtime: "node", entrypoint: "npm start" }).success).toBe(true);
        expect(authorWithBuild({ framework: "dockerfile", dockerfile: "./Dockerfile" }).success).toBe(true);
    });

    it("offers only the two authorable methods in the JSON Schema an MCP client reads", () => {
        const jsonSchema = z.toJSONSchema(authoringPreviewConfigSchema, { io: "input" });
        const frameworks = JSON.stringify(jsonSchema).match(/"const":"[a-z]+"/g) ?? [];
        for (const framework of DEPRECATED_BUILD_FRAMEWORKS) {
            expect(frameworks).not.toContain(`"const":"${framework}"`);
        }
        expect(frameworks).toContain('"const":"runtime"');
        expect(frameworks).toContain('"const":"dockerfile"');
    });
});

describe("previewConfigSchema repositories", () => {
    function parseWithRepositories(repositories: unknown) {
        return previewConfigSchema.safeParse({
            version: 2,
            apps: [
                { name: "web", repository: "acme/web", port: 3000 },
                { name: "api", repository: "acme/api", port: 4000 },
            ],
            repositories,
        });
    }

    it("defaults fallback_branch and leaves sha undefined in authored config", () => {
        const result = parseWithRepositories([{ repo: "acme/api" }]);
        expect(result.success).toBe(true);
        if (result.success) {
            const settings = result.data.repositories[0];
            expect(settings?.fallback_branch).toBe("main");
            expect(settings?.sha).toBeUndefined();
        }
    });

    // The deploy-time enrichment writes `sha` back into resolvedConfig; readers
    // re-parse that JSON, so the field must survive parsing (Zod strips unknown
    // keys, so an absent schema field would silently drop the recorded SHA).
    it("preserves a recorded dependency sha through parsing", () => {
        const result = parseWithRepositories([{ repo: "acme/api", sha: "abc123def456" }]);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.repositories[0]?.sha).toBe("abc123def456");
        }
    });

    it("rejects a repository value that is not an owner/repo full name", () => {
        const result = previewConfigSchema.safeParse({
            version: 2,
            apps: [{ name: "web", repository: "just-an-alias", port: 3000 }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects an app without a repository", () => {
        const result = previewConfigSchema.safeParse({
            version: 2,
            apps: [{ name: "web", port: 3000 }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects duplicate settings entries for the same repository", () => {
        const result = parseWithRepositories([{ repo: "acme/api" }, { repo: "acme/api", fallback_branch: "dev" }]);
        expect(result.success).toBe(false);
    });

    it("warns about a settings entry no app builds from", () => {
        const result = parseWithRepositories([{ repo: "acme/ghost" }]);
        expect(result.success).toBe(true);
        if (result.success) {
            const issues = validatePreviewConfigSemantics(result.data);
            const warning = issues.find((issue) => issue.code === "unreferenced_repository");
            expect(warning?.severity).toBe("warning");
            expect(warning?.path).toEqual(["repositories", 0]);
        }
    });

    it("derives the topology repository set from the apps", () => {
        const result = parseWithRepositories([]);
        expect(result.success).toBe(true);
        if (result.success) {
            expect([...topologyRepositories(result.data)].sort()).toEqual(["acme/api", "acme/web"]);
        }
    });

    // Repository identity is case-insensitive (GitHub full names are), so every
    // membership/duplicate check has to treat case-only variants as the same repo.
    describe("case-insensitive repository identity", () => {
        it("dedupes case-only variants in the topology set, keeping the first-seen casing", () => {
            const result = previewConfigSchema.parse({
                version: 2,
                apps: [
                    { name: "web", repository: "Acme/Web", port: 3000 },
                    { name: "worker", repository: "acme/web", port: 3001 },
                ],
            });
            expect([...topologyRepositories(result)]).toEqual(["Acme/Web"]);
        });

        it("rejects case-only duplicate settings entries", () => {
            const result = parseWithRepositories([{ repo: "acme/api" }, { repo: "Acme/API", fallback_branch: "dev" }]);
            expect(result.success).toBe(false);
        });

        it("accepts a setup-task repo reference that differs only in case", () => {
            const result = previewConfigSchema.parse({
                version: 2,
                apps: [
                    { name: "web", repository: "acme/web", port: 3000 },
                    { name: "api", repository: "Acme/Backend", port: 4000 },
                ],
                services: [
                    {
                        name: "db",
                        recipe: "postgres",
                        setup_tasks: [
                            {
                                command: "rails db:schema:load",
                                frequency: "on_create",
                                location: { type: "separate_job", repo: "acme/backend" },
                            },
                        ],
                    },
                ],
            });
            const issues = validatePreviewConfigSemantics(result);
            expect(issues.some((issue) => issue.code === "unknown_setup_task_repo")).toBe(false);
        });

        it("does not warn about a settings entry that differs from its app only in case", () => {
            const result = parseWithRepositories([{ repo: "Acme/API" }]);
            expect(result.success).toBe(true);
            if (result.success) {
                const issues = validatePreviewConfigSemantics(result.data);
                expect(issues.some((issue) => issue.code === "unreferenced_repository")).toBe(false);
            }
        });
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
            version: 2,
            apps: [{ name: "web", repository: "acme/web", port: 3000, connections }],
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
            version: 2,
            apps: [{ name: "web", repository: "acme/web", port: 3000 }],
            services: [{ name: "flow", recipe: "temporal" }],
        });
        const issues = validatePreviewConfigSemantics(config);
        expect(issues.some((issue) => issue.code === "unreferenced_database_service")).toBe(false);
    });

    it("rejects a reserved key as a connection", () => {
        const result = previewConfigSchema.safeParse({
            version: 2,
            apps: [
                {
                    name: "web",
                    repository: "acme/web",
                    port: 3000,
                    connections: [{ key: "AUTONOMA_PREVIEWKIT", value: "{{db.url}}" }],
                },
            ],
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

describe("sdk_path", () => {
    function parseWithApps(apps: unknown) {
        return previewConfigSchema.safeParse({ version: 2, apps });
    }

    const app = (name: string, extra: Record<string, unknown> = {}) => ({
        name,
        repository: "acme/web",
        port: 3000,
        ...extra,
    });

    it("accepts an absolute path and leaves it off the parsed app when unset", () => {
        const declared = parseWithApps([app("web", { sdk_path: "/autonoma" })]);
        expect(declared.success).toBe(true);
        if (declared.success) expect(declared.data.apps[0]?.sdk_path).toBe("/autonoma");

        // No Zod default on purpose: absent must stay distinguishable from an
        // explicit "/api/autonoma", because that is what tells a caller to leave an
        // already-stored endpoint URL alone.
        const silent = parseWithApps([app("web")]);
        expect(silent.success).toBe(true);
        if (silent.success) expect(silent.data.apps[0]?.sdk_path).toBeUndefined();
    });

    it.each(["api/autonoma", "https://api.customer.com/autonoma", "/autonoma?v=2", "/autonoma#frag"])(
        "rejects %s",
        (path) => {
            expect(parseWithApps([app("web", { sdk_path: path })]).success).toBe(false);
        },
    );

    it("reads the path off the app that hosts the handler", () => {
        expect(
            declaredSdkPath([
                { name: "web", primary: true, sdk_path: "/frontend-route" },
                { name: "api", sdk_implemented: true, sdk_path: "/autonoma" },
            ]),
        ).toBe("/autonoma");
    });

    it("falls back to the primary app's path when no app declares the SDK role", () => {
        expect(declaredSdkPath([{ name: "api" }, { name: "web", primary: true, sdk_path: "/seed" }])).toBe("/seed");
    });

    it("reads a raw stored document, and treats an unreadable one as no opinion", () => {
        expect(sdkPathFromDocument({ apps: [{ name: "api", sdk_implemented: true, sdk_path: "/autonoma" }] })).toBe(
            "/autonoma",
        );
        // Narrower than the full schema on purpose: a document missing fields the
        // deploy needs still answers this question.
        expect(sdkPathFromDocument({ apps: [{ name: "web", sdk_path: "/seed" }] })).toBe("/seed");
        expect(sdkPathFromDocument({ apps: "not-an-array" })).toBeUndefined();
        expect(sdkPathFromDocument(null)).toBeUndefined();
    });

    it("is undefined when the host app declares no path", () => {
        expect(
            declaredSdkPath([
                { name: "api", sdk_implemented: true },
                { name: "web", primary: true },
            ]),
        ).toBeUndefined();
        expect(declaredSdkPath([])).toBeUndefined();
    });
});
