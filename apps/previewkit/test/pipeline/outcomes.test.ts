import type { PreviewBuildOutcome } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { previewConfigSchema } from "../../src/config/schema";
import type { AppBuildOutcome } from "../../src/db";
import { computeFinalOutcomes, toBuildStates, toFinalAppStates } from "../../src/pipeline/outcomes";

const config = previewConfigSchema.parse({
    version: 2,
    apps: [
        { name: "web", repository: "acme/web", path: "./apps/web", port: 3000 },
        { name: "api", repository: "acme/web", path: "./apps/api", port: 4000 },
    ],
});

const buildOk: PreviewBuildOutcome = { status: "success", imageTag: "img:web", durationMs: 100 };
const buildFail: PreviewBuildOutcome = { status: "failed", durationMs: 50, error: "build boom" };

describe("computeFinalOutcomes", () => {
    it("marks an app ok only when build succeeded and deploy is ok", () => {
        const outcomes = computeFinalOutcomes(
            config,
            { web: buildOk, api: buildOk },
            { web: { status: "ok", url: "https://web" }, api: { status: "ok", url: "https://api" } },
        );
        expect(outcomes).toEqual([
            { name: "web", status: "ok", url: "https://web" },
            { name: "api", status: "ok", url: "https://api" },
        ]);
    });

    it("fails an app whose build failed, surfacing the build error and ignoring deploy", () => {
        const [web] = computeFinalOutcomes(config, { web: buildFail }, { web: { status: "ok", url: "https://web" } });
        expect(web).toEqual({ name: "web", status: "failed", error: "build boom" });
    });

    it("fails a built app that was skipped or failed at deploy", () => {
        const outcomes = computeFinalOutcomes(
            config,
            { web: buildOk, api: buildOk },
            {
                web: { status: "skipped", reason: "dependency down" },
                api: { status: "failed", url: "https://api", error: "crash" },
            },
        );
        expect(outcomes[0]).toEqual({ name: "web", status: "failed", error: "Deploy skipped: dependency down" });
        expect(outcomes[1]).toEqual({ name: "api", status: "failed", url: "https://api", error: "crash" });
    });

    it("treats a missing build or deploy outcome as a failure rather than dropping the app", () => {
        const outcomes = computeFinalOutcomes(config, { web: buildOk }, {});
        expect(outcomes[0]).toEqual({ name: "web", status: "failed", error: "No deploy outcome recorded" });
        expect(outcomes[1]).toEqual({ name: "api", status: "failed", error: "No build outcome recorded" });
    });
});

describe("toBuildStates", () => {
    it("maps a successful build to a `built` row carrying the image tag and port", () => {
        const success: AppBuildOutcome = { status: "success", imageTag: "img:web", durationMs: 100 };
        const [web] = toBuildStates(config, { web: success });
        expect(web).toEqual({ appName: "web", status: "built", port: 3000, imageTag: "img:web" });
    });

    it("maps a failed or missing build to a `build_failed` row with the error", () => {
        const failed: AppBuildOutcome = { status: "failed", durationMs: 50, error: "build boom" };
        const states = toBuildStates(config, { web: failed });
        expect(states[0]).toEqual({ appName: "web", status: "build_failed", port: 3000, error: "build boom" });
        expect(states[1]).toEqual({
            appName: "api",
            status: "build_failed",
            port: 4000,
            error: "No build outcome recorded",
        });
    });
});

describe("toFinalAppStates", () => {
    it("maps build+deploy success to a `ready` row with image tag and url", () => {
        const [web] = toFinalAppStates(
            config,
            { web: buildOk },
            { web: { status: "ok", url: "https://web" } },
            { web: "img:web" },
        );
        expect(web).toEqual({ appName: "web", status: "ready", port: 3000, imageTag: "img:web", url: "https://web" });
    });

    it("distinguishes build_failed, skipped, and deploy_failed terminal states", () => {
        const states = toFinalAppStates(
            config,
            { web: buildOk, api: buildFail },
            { web: { status: "skipped", reason: "dependency down" } },
            { web: "img:web" },
        );
        // web built but deploy skipped -> skipped (no imageTag on a skip)
        expect(states[0]).toEqual({
            appName: "web",
            status: "skipped",
            port: 3000,
            error: "Deploy skipped: dependency down",
        });
        // api build failed -> build_failed, deploy never considered
        expect(states[1]).toEqual({ appName: "api", status: "build_failed", port: 4000, error: "build boom" });
    });

    it("marks a built app with no deploy outcome as deploy_failed, keeping the image tag", () => {
        const [web] = toFinalAppStates(config, { web: buildOk }, {}, { web: "img:web" });
        expect(web).toEqual({
            appName: "web",
            status: "deploy_failed",
            port: 3000,
            imageTag: "img:web",
            error: "No deploy outcome recorded",
        });
    });
});

describe("repo-skipped apps in the rollup", () => {
    const skipReason =
        'Repository acme/backend has neither branch "feature/x" nor fallback branch "main" - apps from it were skipped';

    it("counts a repo-skipped app as failed so full readiness stays false", () => {
        const outcomes = computeFinalOutcomes(
            config,
            { web: buildOk },
            { web: { status: "ok", url: "https://web" }, api: { status: "skipped", reason: "build failed" } },
            { api: skipReason },
        );
        // One ready + one skipped must roll up as 1/2, never 1/1.
        expect(outcomes).toHaveLength(2);
        expect(outcomes.filter((o) => o.status === "ok")).toHaveLength(1);
        expect(outcomes.find((o) => o.name === "api")).toEqual({ name: "api", status: "failed", error: skipReason });
    });

    it("keeps the branch-resolution reason on the skipped row instead of a generic build message", () => {
        const states = toFinalAppStates(
            config,
            { web: buildOk },
            { web: { status: "ok", url: "https://web" }, api: { status: "skipped", reason: "build failed" } },
            { web: "img:web" },
            { api: skipReason },
        );
        expect(states.find((s) => s.appName === "api")).toEqual({
            appName: "api",
            status: "skipped",
            port: 4000,
            error: skipReason,
        });
        expect(states.find((s) => s.appName === "web")?.status).toBe("ready");
    });
});
