/**
 * The previewkit deploy contract: the plain, serializable data shared between
 * `apps/api` (which launches a preview deploy/teardown/redeploy as a Kubernetes
 * Job) and `apps/previewkit` (the runner that executes it). Kept dependency-free
 * - only scalars, string maps, and flat result rows - so it can cross the API ->
 * Job boundary as JSON. The rich preview config crosses as a JSON string
 * (`mergedConfigJson`) and is re-validated with `trustedPreviewConfigSchema`
 * inside the runner.
 */

/** Serializable mirror of apps/previewkit's `PullRequestEvent`. */
export interface PreviewDeployEvent {
    action: "opened" | "synchronize" | "closed" | "reopened" | "ready_for_review";
    prNumber: number;
    repoFullName: string;
    organizationId: string;
    githubRepositoryId: number;
    headSha: string;
    headRef: string;
    baseSha: string;
    baseRef: string;
    cloneUrl: string;
    /**
     * The autonoma `Branch` this environment deploys (the PR's feature branch, or the main branch for env 0),
     * resolved by the API when a matching `Application` exists. Carried opaquely so the runner can link the
     * `PreviewkitEnvironment` to the branch without knowing the branch model. Undefined for repos with no
     * onboarded Application.
     */
    branchId?: string;
}

/** Serializable mirror of apps/previewkit's per-app `AppBuildOutcome`. */
export type PreviewBuildOutcome =
    | { status: "success"; imageTag: string; durationMs: number; runtime?: string }
    | { status: "failed"; durationMs: number; error: string; runtime?: string };

export interface BuildPreviewImagesOutput {
    /**
     * `JSON.stringify` of the effective `PreviewConfig`; parsed at the boundary.
     * Carries the FULL topology, `skippedApps` included, so infra (Gatekeeper
     * routes) and the deploy-wave graph always see every app.
     */
    mergedConfigJson: string;
    /** app name -> pushed ECR image tag (only successfully built apps). */
    imageTags: Record<string, string>;
    /** Per-app build outcomes, needed to render build-failed apps in the comment. */
    buildOutcomes: Record<string, PreviewBuildOutcome>;
    /** Dependency fallback notices for the PR comment. */
    warnings: string[];
    /**
     * app name -> reason for apps whose repository had no resolvable branch this
     * round. They stay in the config (routes, deploy waves) but are never built
     * or deployed, their hooks are skipped, and the readiness rollup counts them
     * as not ready.
     */
    skippedApps?: Record<string, string>;
}

export interface DeployPreviewEnvironmentInput {
    event: PreviewDeployEvent;
    namespace: string;
    commentId: string;
    mergedConfigJson: string;
    imageTags: Record<string, string>;
    buildOutcomes: Record<string, PreviewBuildOutcome>;
    warnings: string[];
    /** See {@link BuildPreviewImagesOutput.skippedApps}. */
    skippedApps?: Record<string, string>;
    /**
     * Scope the deploy to a single app (per-app redeploy). Infra still applies
     * with the full config (so sibling Gatekeeper routes + external secrets are
     * preserved), but only this app is (re)deployed, only its hooks run, and the
     * outcome is merged into the environment rather than overwriting it.
     * Undefined deploys every app (the normal full deploy).
     */
    appName?: string | undefined;
}

/** Flat, comment-ready per-app row. */
export interface PreviewServiceResult {
    name: string;
    status: "ready" | "failed";
    url?: string;
    error?: string;
}

export interface DeployPreviewEnvironmentOutput {
    /** Every app came up. */
    ready: boolean;
    readyCount: number;
    totalCount: number;
    urls: Record<string, string>;
    services: PreviewServiceResult[];
    /** Human-readable dependency fallback notices for the PR comment. */
    warnings: string[];
    /** First ready app url, for the comment header. */
    previewUrl?: string;
    /** Primary app url, for the GitHub deployment status (diffs trigger). */
    primaryUrl?: string;
    /**
     * Url of the app hosting the Environment Factory handler (`sdk_implemented`,
     * else the primary app) - the origin scenario up/down calls are sent to.
     */
    sdkAppUrl?: string;
}

/** `rebuild` re-builds the image then redeploys; `restart` re-rolls the running pods. */
export type PreviewRedeployAppMode = "rebuild" | "restart";

/** Params to launch a full preview deploy for a (repo, PR). */
export interface TriggerPreviewDeployParams {
    event: PreviewDeployEvent;
}

/** Params to launch a preview teardown for a (repo, PR). */
export interface TriggerPreviewTeardownParams {
    event: PreviewDeployEvent;
}

/** Params to launch a single-app redeploy within a live preview environment. */
export interface TriggerPreviewRedeployAppParams {
    event: PreviewDeployEvent;
    /** The environment's namespace, resolved from the env row by the caller. */
    namespace: string;
    /** The single app to redeploy. */
    appName: string;
    mode: PreviewRedeployAppMode;
}
