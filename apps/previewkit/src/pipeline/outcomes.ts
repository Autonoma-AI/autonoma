import type { PreviewAddonResult, PreviewBuildOutcome } from "@autonoma/types";
import type { AddonProvisionOutcome } from "../addons/addon-manager";
import type { PreviewConfig } from "../config/schema";
import type { AppBuildOutcome, AppStateUpdate } from "../db";
import type { AppDeployOutcome } from "../deployer/deployer";

/**
 * Pure mappers from the config + per-app build/deploy outcomes to the shapes the
 * pipeline persists (lifecycle-state rows) or reports (PR-comment outcome rows).
 * They hold no state and do no IO - every input is passed in - so they are split
 * out of {@link PreviewPipeline} to be unit-tested directly.
 */

/**
 * Combined per-app outcome rendered in the PR comment. Bundles the build and
 * deploy phases so the comment can show one row per app with the final status.
 */
export interface AppFinalOutcome {
    name: string;
    status: "ok" | "failed";
    url?: string;
    error?: string;
}

/**
 * Combines per-app build and deploy outcomes into a single status row per
 * app, used for both the PR comment table and the commit-status rollup.
 *
 * Stage A keeps this binary: an app is `ok` only if both build and deploy
 * succeeded; everything else is `failed`. The `error` field surfaces the
 * earliest failure (build error wins over deploy error, since a failed
 * build implies a skipped deploy).
 */
export function computeFinalOutcomes(
    config: PreviewConfig,
    appBuilds: Record<string, PreviewBuildOutcome>,
    deployOutcomes: Record<string, AppDeployOutcome>,
): AppFinalOutcome[] {
    return config.apps.map((app) => {
        const build = appBuilds[app.name];
        const deploy = deployOutcomes[app.name];

        if (build == null) {
            // Defensive: every config app should have been built. Treat
            // a missing entry as a failure rather than silently dropping.
            return { name: app.name, status: "failed", error: "No build outcome recorded" };
        }

        if (build.status === "failed") {
            return { name: app.name, status: "failed", error: build.error };
        }

        if (deploy == null) {
            return { name: app.name, status: "failed", error: "No deploy outcome recorded" };
        }

        if (deploy.status === "ok") {
            return { name: app.name, status: "ok", url: deploy.url };
        }

        if (deploy.status === "skipped") {
            return { name: app.name, status: "failed", error: `Deploy skipped: ${deploy.reason}` };
        }

        return { name: app.name, status: "failed", url: deploy.url, error: deploy.error };
    });
}

/**
 * Maps per-app build outcomes to lifecycle-row transitions: `built` (with
 * imageTag) on success, `build_failed` (with the error) otherwise. Written
 * right after the build phase so each app's build verdict is persisted
 * before any deploy work begins.
 */
export function toBuildStates(config: PreviewConfig, appBuilds: Record<string, AppBuildOutcome>): AppStateUpdate[] {
    return config.apps.map((app) => {
        const outcome = appBuilds[app.name];
        if (outcome == null) {
            return {
                appName: app.name,
                status: "build_failed",
                port: app.port,
                error: "No build outcome recorded",
            };
        }
        if (outcome.status === "success") {
            return { appName: app.name, status: "built", port: app.port, imageTag: outcome.imageTag };
        }
        return { appName: app.name, status: "build_failed", port: app.port, error: outcome.error };
    });
}

/**
 * Maps the combined build + deploy outcomes to the terminal lifecycle state
 * for every app: `build_failed`, `skipped` (built upstream-failed so deploy
 * was never attempted), `deploy_failed` (with the reason), or `ready`. This
 * is what makes "A and B are ready but C failed to deploy" a set of distinct
 * persisted rows rather than an inferred absence.
 */
export function toFinalAppStates(
    config: PreviewConfig,
    buildOutcomes: Record<string, PreviewBuildOutcome>,
    deployOutcomes: Record<string, AppDeployOutcome>,
    imageTags: Record<string, string>,
): AppStateUpdate[] {
    return config.apps.map((app) => {
        const port = app.port;
        const build = buildOutcomes[app.name];
        const deploy = deployOutcomes[app.name];
        const imageTag = imageTags[app.name];

        if (build == null || build.status === "failed") {
            return {
                appName: app.name,
                status: "build_failed",
                port,
                error: build?.error ?? "No build outcome recorded",
            };
        }
        if (deploy == null) {
            return {
                appName: app.name,
                status: "deploy_failed",
                port,
                imageTag,
                error: "No deploy outcome recorded",
            };
        }
        if (deploy.status === "ok") {
            return { appName: app.name, status: "ready", port, imageTag, url: deploy.url };
        }
        if (deploy.status === "skipped") {
            return { appName: app.name, status: "skipped", port, error: `Deploy skipped: ${deploy.reason}` };
        }
        return { appName: app.name, status: "deploy_failed", port, imageTag, url: deploy.url, error: deploy.error };
    });
}

/**
 * Maps addon provisioning outcomes to the PR-comment addon rows, resolving each
 * addon's provider from the config (or `unknown` if the config no longer lists it).
 */
export function toAddonResults(config: PreviewConfig, addonOutcomes: AddonProvisionOutcome[]): PreviewAddonResult[] {
    return addonOutcomes.map((outcome) => {
        const addon = config.addons.find((candidate) => candidate.name === outcome.name);
        const row: PreviewAddonResult = {
            name: outcome.name,
            provider: addon?.provider ?? "unknown",
            status: outcome.status === "ok" ? "ready" : "failed",
        };
        if (outcome.status === "failed") row.error = outcome.error;
        return row;
    });
}
