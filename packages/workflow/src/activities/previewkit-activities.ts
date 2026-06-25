/**
 * Activities executed on the {@link TaskQueue.PREVIEWKIT} task queue. The
 * implementations live in `apps/previewkit` (they wrap the existing
 * `PreviewPipeline` collaborators - Builder, Deployer, AddonManager,
 * GitHubProvider - which carry the heavy k8s/AWS/buildkit dependencies).
 *
 * This interface is intentionally dependency-free: it threads only plain
 * serializable data so `@autonoma/workflow` never imports app-side types.
 * The rich preview config crosses as a JSON string
 * (`mergedConfigJson`) and is re-validated with the existing
 * `trustedPreviewConfigSchema` at the activity boundary inside the app;
 * everything else is scalars, string maps, or flat result rows.
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
}

export interface PreparePreviewDeployInput {
    event: PreviewDeployEvent;
    /** Pin the config revision to reproduce a redeploy's original topology. */
    configRevisionId?: string | undefined;
}

export interface PreparePreviewDeployOutput {
    /**
     * True when the repo opted out (not linked to an Application, or no active
     * config revision). The workflow ends cleanly without building.
     */
    skipped: boolean;
    namespace: string;
    /** GitHub PR comment id, or "" when feedback is disabled / posting failed. */
    commentId: string;
    feedbackEnabled: boolean;
}

export interface BuildPreviewImagesInput {
    event: PreviewDeployEvent;
    namespace: string;
    /** Pin the config revision to reproduce a redeploy's original topology. */
    configRevisionId?: string | undefined;
}

/** Serializable mirror of apps/previewkit's per-app `AppBuildOutcome`. */
export type PreviewBuildOutcome =
    | { status: "success"; imageTag: string; durationMs: number; runtime?: string }
    | { status: "failed"; durationMs: number; error: string; runtime?: string };

export interface BuildPreviewImagesOutput {
    /** `JSON.stringify` of the merged `PreviewConfig`; parsed at the boundary. */
    mergedConfigJson: string;
    /** app name -> pushed ECR image tag (only successfully built apps). */
    imageTags: Record<string, string>;
    /** addon name -> provider outputs, fed into runtime env templates. */
    addonOutputs: Record<string, Record<string, string>>;
    /** Per-app build outcomes, needed to render build-failed apps in the comment. */
    buildOutcomes: Record<string, PreviewBuildOutcome>;
    /** Comment-ready addon rows (provisioning happens during build). */
    addons: PreviewAddonResult[];
    /** Dependency fallback notices for the PR comment. */
    warnings: string[];
    /** Names of apps from the primary repo, used to resolve the primary url. */
    primaryAppNames: string[];
}

export interface DeployPreviewEnvironmentInput {
    event: PreviewDeployEvent;
    namespace: string;
    commentId: string;
    mergedConfigJson: string;
    imageTags: Record<string, string>;
    addonOutputs: Record<string, Record<string, string>>;
    buildOutcomes: Record<string, PreviewBuildOutcome>;
    addons: PreviewAddonResult[];
    warnings: string[];
    primaryAppNames: string[];
}

/** Flat, comment-ready per-app row. */
export interface PreviewServiceResult {
    name: string;
    status: "ready" | "failed";
    url?: string;
    error?: string;
}

/** Flat, comment-ready per-addon row. */
export interface PreviewAddonResult {
    name: string;
    provider: string;
    status: "ready" | "failed";
    error?: string;
}

export interface DeployPreviewEnvironmentOutput {
    /** Every app came up. */
    ready: boolean;
    readyCount: number;
    totalCount: number;
    urls: Record<string, string>;
    services: PreviewServiceResult[];
    addons: PreviewAddonResult[];
    /** Human-readable dependency fallback notices for the PR comment. */
    warnings: string[];
    /** First ready app url, for the comment header. */
    previewUrl?: string;
    /** Primary app url, for the GitHub deployment status (diffs trigger). */
    primaryUrl?: string;
}

export interface FinalizePreviewDeployInput {
    event: PreviewDeployEvent;
    namespace: string;
    commentId: string;
    feedbackEnabled: boolean;
    result: DeployPreviewEnvironmentOutput;
}

export interface FailPreviewDeployInput {
    event: PreviewDeployEvent;
    namespace: string;
    commentId: string;
    feedbackEnabled: boolean;
    error: string;
}

export interface TeardownPreviewEnvironmentInput {
    /**
     * `action` is "closed" and `headSha` may be "" (webhook close events don't
     * carry it) - the activity falls back to the environment row's stored sha.
     */
    event: PreviewDeployEvent;
}

export interface MarkPreviewDeploySupersededInput {
    event: PreviewDeployEvent;
    namespace: string;
}

export interface PreviewkitActivities {
    preparePreviewDeploy(input: PreparePreviewDeployInput): Promise<PreparePreviewDeployOutput>;
    buildPreviewImages(input: BuildPreviewImagesInput): Promise<BuildPreviewImagesOutput>;
    deployPreviewEnvironment(input: DeployPreviewEnvironmentInput): Promise<DeployPreviewEnvironmentOutput>;
    finalizePreviewDeploy(input: FinalizePreviewDeployInput): Promise<void>;
    failPreviewDeploy(input: FailPreviewDeployInput): Promise<void>;
    teardownPreviewEnvironment(input: TeardownPreviewEnvironmentInput): Promise<void>;
    /**
     * Finalizes a superseded deploy's build row only (never the env row, which
     * the newest run owns). Called from the deploy workflow's cancellation path.
     */
    markPreviewDeploySuperseded(input: MarkPreviewDeploySupersededInput): Promise<void>;
}
