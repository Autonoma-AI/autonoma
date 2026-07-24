import type { AuthoredBuild } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { type BuildDecisions, migratePreviewConfigBuild } from "../../../src/scripts/migrate-preview-config-build.lib";

// Builds a minimal legacy config document with a single app whose build-strategy
// fields are supplied by the caller. Everything else is a valid, deployable base.
function docWithApp(app: Record<string, unknown>): Record<string, unknown> {
    return {
        version: 1,
        apps: [{ name: "web", port: 3000, primary: true, ...app }],
        services: [],
    };
}

// A turbo monorepo app expressed the only way a decision now can be: the
// `runtime` escape hatch, with the install/build commands written out and the
// start command as the entrypoint.
const NEXT_TURBO: AuthoredBuild = {
    framework: "runtime",
    runtime: "node",
    version: "22",
    build_script: "corepack enable\npnpm install --frozen-lockfile\npnpm exec turbo run build --filter=./apps/web",
    entrypoint: "pnpm exec turbo run start --filter=./apps/web",
    build_context: "root",
};

function decisions(entries: Record<string, AuthoredBuild>): BuildDecisions {
    return new Map(Object.entries(entries));
}

describe("migratePreviewConfigBuild", () => {
    it("auto-migrates a bare dockerfile app to framework: dockerfile and drops the legacy field", () => {
        const result = migratePreviewConfigBuild(docWithApp({ dockerfile: "Dockerfile" }), decisions({}));

        expect(result.changed).toBe(true);
        expect(result.unresolved).toEqual([]);
        expect(result.migrations[0]).toMatchObject({
            appName: "web",
            from: "bare_dockerfile",
            action: "migrated_dockerfile",
        });

        const app = result.document?.apps[0];
        expect(app?.build).toEqual({ framework: "dockerfile", dockerfile: "Dockerfile", build_context: "app" });
        expect(app?.dockerfile).toBeUndefined();
    });

    it("maps a root-normalized legacy build_context to build_context: root", () => {
        const result = migratePreviewConfigBuild(
            docWithApp({ dockerfile: "docker/Dockerfile", build_context: "." }),
            decisions({}),
        );

        expect(result.document?.apps[0]?.build).toEqual({
            framework: "dockerfile",
            dockerfile: "docker/Dockerfile",
            build_context: "root",
        });
        expect(result.document?.apps[0]?.build_context).toBeUndefined();
    });

    it("leaves a turbo app unresolved when no decision is supplied", () => {
        const result = migratePreviewConfigBuild(docWithApp({ monorepo: "turbo" }), decisions({}));

        expect(result.unresolved).toEqual(["web"]);
        expect(result.document).toBeUndefined();
        expect(result.migrations[0]).toMatchObject({ from: "monorepo_turbo", action: "unresolved" });
    });

    it("migrates a turbo app with a runtime decision and removes the monorepo field", () => {
        const result = migratePreviewConfigBuild(docWithApp({ monorepo: "turbo" }), decisions({ web: NEXT_TURBO }));

        expect(result.changed).toBe(true);
        expect(result.unresolved).toEqual([]);
        expect(result.migrations[0]).toMatchObject({ from: "monorepo_turbo", action: "migrated_decision" });

        const app = result.document?.apps[0];
        expect(app?.build).toMatchObject({ framework: "runtime", runtime: "node", build_context: "root" });
        expect(app?.monorepo).toBeUndefined();
    });

    it("leaves a railpack-autodetect app (no build fields) unresolved without a decision", () => {
        const result = migratePreviewConfigBuild(docWithApp({}), decisions({}));

        expect(result.unresolved).toEqual(["web"]);
        expect(result.migrations[0]).toMatchObject({ from: "railpack_autodetect", action: "unresolved" });
    });

    it("skips an app that already has a build block and reports no change", () => {
        const result = migratePreviewConfigBuild(
            docWithApp({
                build: { framework: "node", package_manager: "pnpm", node_version: "22", build_context: "app" },
            }),
            decisions({}),
        );

        expect(result.changed).toBe(false);
        expect(result.migrations[0]).toMatchObject({ from: "has_build", action: "skip_has_build" });
    });

    it("is idempotent - re-running over its own output produces no further change", () => {
        const first = migratePreviewConfigBuild(docWithApp({ dockerfile: "Dockerfile" }), decisions({}));
        expect(first.changed).toBe(true);

        const second = migratePreviewConfigBuild(first.document, decisions({}));
        expect(second.changed).toBe(false);
        expect(second.migrations[0]).toMatchObject({ action: "skip_has_build" });
    });

    it("preserves unrelated app fields, including platform-authored resource overrides", () => {
        const document = docWithApp({
            dockerfile: "Dockerfile",
            command: "node server.js",
            resources: { cpu: "500m", memory: "2Gi" },
        });
        const result = migratePreviewConfigBuild(document, decisions({}));

        const app = result.document?.apps[0];
        expect(app?.command).toBe("node server.js");
        expect(app?.resources.cpu).toBe("500m");
    });

    it("rejects a value that is not a migratable config document", () => {
        const result = migratePreviewConfigBuild({ nonsense: true }, decisions({}));

        expect(result.changed).toBe(false);
        expect(result.validationError).toContain("migratable preview config");
    });
});
