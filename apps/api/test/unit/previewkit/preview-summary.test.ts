import { describe, expect, it } from "vitest";
import { buildPreviewAppSummaries, deriveEnvironmentHealth } from "../../../src/routes/deployments/preview-summary";

describe("deriveEnvironmentHealth", () => {
    it("reads ready when every app is ready, even if the pipeline stamped the environment failed", () => {
        // The reported inconsistency: a fully-deployed environment whose post-deploy
        // GitHub finalization failed has status `failed` but every app `ready`.
        const health = deriveEnvironmentHealth(
            "failed",
            [{ status: "ready" }, { status: "ready" }, { status: "ready" }],
            [],
        );
        expect(health).toBe("ready");
    });

    it("reads degraded when all apps are ready but an addon failed", () => {
        const health = deriveEnvironmentHealth("failed", [{ status: "ready" }], [{ status: "failed" }]);
        expect(health).toBe("degraded");
    });

    it("reads ready when all apps and addons are healthy", () => {
        const health = deriveEnvironmentHealth("ready", [{ status: "ready" }], [{ status: "ok" }]);
        expect(health).toBe("ready");
    });

    it("reads degraded when some apps are up but another failed or was skipped", () => {
        expect(deriveEnvironmentHealth("ready", [{ status: "ready" }, { status: "deploy_failed" }], [])).toBe(
            "degraded",
        );
        expect(deriveEnvironmentHealth("ready", [{ status: "ready" }, { status: "build_failed" }], [])).toBe(
            "degraded",
        );
        expect(deriveEnvironmentHealth("ready", [{ status: "ready" }, { status: "skipped" }], [])).toBe("degraded");
    });

    it("reads building while any app is still in flight", () => {
        expect(deriveEnvironmentHealth("deploying", [{ status: "ready" }, { status: "deploying" }], [])).toBe(
            "building",
        );
        expect(deriveEnvironmentHealth("building", [{ status: "building" }], [])).toBe("building");
        expect(deriveEnvironmentHealth("pending", [{ status: "pending" }], [])).toBe("building");
    });

    it("reads failed when nothing came up", () => {
        expect(deriveEnvironmentHealth("failed", [{ status: "build_failed" }, { status: "deploy_failed" }], [])).toBe(
            "failed",
        );
    });

    it("falls back to the pipeline status before any app rows exist", () => {
        expect(deriveEnvironmentHealth("pending", [], [])).toBe("building");
        expect(deriveEnvironmentHealth("building", [], [])).toBe("building");
        expect(deriveEnvironmentHealth("failed", [], [])).toBe("failed");
        expect(deriveEnvironmentHealth("ready", [], [])).toBe("ready");
        expect(deriveEnvironmentHealth("ready", [], [{ status: "failed" }])).toBe("degraded");
    });

    it("reads unknown for a torn-down environment", () => {
        expect(deriveEnvironmentHealth("torn_down", [{ status: "ready" }], [])).toBe("unknown");
    });
});

describe("buildPreviewAppSummaries", () => {
    it("returns every app with its status sorted by name, including apps that have no URL", () => {
        const summaries = buildPreviewAppSummaries(
            [
                { appName: "web", status: "ready", url: "https://web", error: null },
                { appName: "api", status: "building", url: null, error: null },
                { appName: "worker", status: "build_failed", url: null, error: "compile error" },
            ],
            { web: "https://web" },
        );

        expect(summaries).toEqual([
            { appName: "api", status: "building", url: undefined, error: undefined },
            { appName: "web", status: "ready", url: "https://web", error: undefined },
            { appName: "worker", status: "build_failed", url: undefined, error: "compile error" },
        ]);
    });

    it("surfaces a legacy url-only app that has no app-instance row as ready", () => {
        const summaries = buildPreviewAppSummaries([], { legacy: "https://legacy" });
        expect(summaries).toEqual([{ appName: "legacy", status: "ready", url: "https://legacy", error: undefined }]);
    });

    it("falls back to the urls map when an instance has no url of its own", () => {
        const summaries = buildPreviewAppSummaries([{ appName: "web", status: "ready", url: null, error: null }], {
            web: "https://fallback",
        });
        expect(summaries).toEqual([{ appName: "web", status: "ready", url: "https://fallback", error: undefined }]);
    });

    it("returns an empty list when there are no apps", () => {
        expect(buildPreviewAppSummaries([], {})).toEqual([]);
    });
});
