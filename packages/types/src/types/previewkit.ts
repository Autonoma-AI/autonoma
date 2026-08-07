/**
 * The previewkit deploy contract: the plain, serializable data shared between
 * `apps/api` (which launches a preview deploy/teardown/redeploy as a Kubernetes
 * Job) and `apps/previewkit` (the runner that executes it). Kept dependency-free
 * - only scalars, string maps, and flat result rows - so it can cross the API ->
 * Job boundary as JSON. The rich preview config crosses as a JSON string
 * (`mergedConfigJson`) and is re-validated with `trustedPreviewConfigSchema`
 * inside the runner.
 */

/**
 * The environment number of an application's main-branch preview. Previewkit keys an environment on
 * `(repoFullName, prNumber)`, and the main branch has no PR, so it occupies the number no PR can have. This is the
 * environment's real identity, not an absence marker: what a run analyzes is carried by `AnalysisRunTarget`, and
 * no consumer may read this number as "there is no PR".
 */
export const MAIN_BRANCH_ENVIRONMENT_NUMBER = 0;

/**
 * `prNumber` is {@link MAIN_BRANCH_ENVIRONMENT_NUMBER} for the main-branch environment - GitHub PR numbers
 * start at 1.
 */
export interface PreviewDeployTarget {
    repoFullName: string;
    prNumber: number;
    organizationId: string;
    githubRepositoryId: number;
    headSha: string;
    headRef: string;
    /**
     * The autonoma `Branch` this environment deploys (the PR's feature branch, or the main branch for env 0),
     * resolved by the API when a matching `Application` exists. Carried opaquely so the runner can link the
     * `PreviewkitEnvironment` to the branch without knowing the branch model. Undefined for repos with no
     * onboarded Application.
     */
    branchId?: string;
}

/** A rebuild or restart of ONE app inside a live environment, at the head that environment already carries. */
export interface PreviewRedeployTarget {
    repoFullName: string;
    prNumber: number;
    organizationId: string;
    githubRepositoryId: number;
    headSha: string;
    headRef: string;
}

/** Deleting an environment. No head ref, and the sha is optional: a close webhook does not carry one. */
export interface PreviewTeardownTarget {
    repoFullName: string;
    prNumber: number;
    organizationId: string;
    /** The deployed commit, for the teardown commit status. Absent from a close webhook; read from the env row. */
    headSha?: string;
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
    target: PreviewDeployTarget;
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
    /** Primary app url, for the GitHub deployment status. */
    primaryUrl?: string;
}

/** `rebuild` re-builds the image then redeploys; `restart` re-rolls the running pods. */
export type PreviewRedeployAppMode = "rebuild" | "restart";

/** Params to launch a single-app redeploy within a live preview environment. */
export interface TriggerPreviewRedeployAppParams {
    target: PreviewRedeployTarget;
    /** The environment's namespace, resolved from the env row by the caller. */
    namespace: string;
    /** The single app to redeploy. */
    appName: string;
    mode: PreviewRedeployAppMode;
}
