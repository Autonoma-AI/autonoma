import { describe, expect, it } from "vitest";
import { migratePreviewConfigToV2, type MigrateV2Result } from "../../../src/scripts/migrate-preview-config-v2.lib";

const DEPENDENCY_SHA = "a".repeat(40);

/** Narrows a result to the migrated document, failing the test on any other status. */
function expectMigrated(result: MigrateV2Result): Record<string, unknown> {
    if (result.status !== "migrated") {
        throw new Error(`expected a migrated document, got ${JSON.stringify(result)}`);
    }
    return result.document;
}

describe("migratePreviewConfigToV2", () => {
    it("migrates a single-repo v1 document: version 2, repository stamped, config wrapper gone", () => {
        const document = expectMigrated(
            migratePreviewConfigToV2({
                document: {
                    version: 1,
                    config: {},
                    apps: [{ name: "web", path: ".", port: 3000, primary: true }],
                    services: [{ name: "db", recipe: "postgres", version: "16" }],
                },
                primaryRepository: "acme/web",
            }),
        );

        expect(document["version"]).toBe(2);
        expect(document).not.toHaveProperty("config");
        expect(document).not.toHaveProperty("repositories");
        expect(document).not.toHaveProperty("branch_convention");
        expect(document["apps"]).toEqual([
            { name: "web", path: ".", port: 3000, primary: true, repository: "acme/web" },
        ]);
        expect(document["services"]).toEqual([{ name: "db", recipe: "postgres", version: "16" }]);
    });

    it("folds a multirepo v1 document and its sidecar into the one v2 document", () => {
        const document = expectMigrated(
            migratePreviewConfigToV2({
                document: {
                    version: 1,
                    config: {
                        multirepo: {
                            branch_convention: { type: "regex", pattern: "^feature/(.+)$", replacement: "deps/$1" },
                            repos: [{ name: "api", repo: "acme/api", fallback_branch: "develop", sha: DEPENDENCY_SHA }],
                        },
                    },
                    apps: [{ name: "web", path: ".", port: 3000, primary: true }],
                    services: [
                        {
                            name: "db",
                            recipe: "postgres",
                            setup_tasks: [
                                {
                                    command: "make seed",
                                    frequency: "on_create",
                                    // v1 referenced the multirepo entry by alias; v2 uses full names.
                                    location: { type: "separate_job", repo: "api" },
                                },
                            ],
                        },
                    ],
                    hooks: { pre_deploy: [{ app: "web", command: "echo primary" }] },
                },
                dependencyDocuments: [
                    {
                        repo: "acme/api",
                        document: {
                            version: 1,
                            apps: [{ name: "api-app", path: ".", port: 4000 }],
                            services: [{ name: "cache", recipe: "redis" }],
                            hooks: { post_deploy: [{ app: "api-app", command: "echo dep" }] },
                        },
                    },
                ],
                primaryRepository: "acme/web",
            }),
        );

        // The multirepo block hoists: entries lose the alias, keep the fallback
        // branch and the recorded deploy sha; the convention moves to the root.
        expect(document["repositories"]).toEqual([
            { repo: "acme/api", fallback_branch: "develop", sha: DEPENDENCY_SHA },
        ]);
        expect(document["branch_convention"]).toEqual({
            type: "regex",
            pattern: "^feature/(.+)$",
            replacement: "deps/$1",
        });

        // Sidecar apps fold in behind the primary apps, each tagged with its repo.
        expect(document["apps"]).toEqual([
            { name: "web", path: ".", port: 3000, primary: true, repository: "acme/web" },
            { name: "api-app", path: ".", port: 4000, repository: "acme/api" },
        ]);

        // Services merge, and the setup-task alias maps to the full name.
        expect(document["services"]).toEqual([
            {
                name: "db",
                recipe: "postgres",
                setup_tasks: [
                    {
                        command: "make seed",
                        frequency: "on_create",
                        location: { type: "separate_job", repo: "acme/api" },
                    },
                ],
            },
            { name: "cache", recipe: "redis" },
        ]);

        // Hooks merge, primary first.
        expect(document["hooks"]).toEqual({
            pre_deploy: [{ app: "web", command: "echo primary" }],
            post_deploy: [{ app: "api-app", command: "echo dep" }],
        });
    });

    it("short-circuits an already-v2 document", () => {
        const result = migratePreviewConfigToV2({
            document: { version: 2, apps: [{ name: "web", repository: "acme/web", port: 3000 }] },
            primaryRepository: "acme/web",
        });

        expect(result).toEqual({ status: "already_v2" });
    });

    it("reports a document that is neither v1 nor v2 as invalid", () => {
        const result = migratePreviewConfigToV2({
            document: { version: 3, apps: [] },
            primaryRepository: "acme/web",
        });

        expect(result).toMatchObject({ status: "invalid", reason: expect.stringContaining("v1") });
    });

    it("reports an unparsable dependencyDocuments sidecar as invalid", () => {
        const result = migratePreviewConfigToV2({
            document: { version: 1, apps: [{ name: "web", path: ".", port: 3000, primary: true }] },
            // Missing the required `document` payload on the sidecar entry.
            dependencyDocuments: [{ repo: "acme/api" }],
            primaryRepository: "acme/web",
        });

        expect(result).toMatchObject({
            status: "invalid",
            reason: expect.stringContaining("dependencyDocuments"),
        });
    });

    it("attributes already-merged apps via appRepositories overrides, defaulting to the primary repo", () => {
        // A resolvedConfig row already carries the merged topology; only the
        // caller knows which app came from which repo.
        const document = expectMigrated(
            migratePreviewConfigToV2({
                document: {
                    version: 1,
                    apps: [
                        { name: "web", path: ".", port: 3000, primary: true },
                        { name: "api-app", path: ".", port: 4000 },
                    ],
                    services: [],
                },
                primaryRepository: "acme/web",
                appRepositories: new Map([["api-app", "acme/api"]]),
            }),
        );

        expect(document["apps"]).toEqual([
            { name: "web", path: ".", port: 3000, primary: true, repository: "acme/web" },
            { name: "api-app", path: ".", port: 4000, repository: "acme/api" },
        ]);
    });

    it("passes unknown fields on the root, apps, and services through verbatim", () => {
        const document = expectMigrated(
            migratePreviewConfigToV2({
                document: {
                    version: 1,
                    domain: "preview.example.com",
                    x_vendor: { token: "abc" },
                    apps: [{ name: "web", path: ".", port: 3000, primary: true, legacy_flag: true }],
                    services: [{ name: "db", recipe: "postgres", note: "keep" }],
                },
                primaryRepository: "acme/web",
            }),
        );

        expect(document["domain"]).toBe("preview.example.com");
        expect(document["x_vendor"]).toEqual({ token: "abc" });
        expect(document["apps"]).toEqual([
            { name: "web", path: ".", port: 3000, primary: true, legacy_flag: true, repository: "acme/web" },
        ]);
        expect(document["services"]).toEqual([{ name: "db", recipe: "postgres", note: "keep" }]);
    });
});
