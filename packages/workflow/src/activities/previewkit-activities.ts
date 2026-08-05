import type { PreviewDeployTarget } from "@autonoma/types";

/**
 * All on {@link TaskQueue.GENERAL}: none clones a repository, and launching a build Job needs RBAC only that
 * worker's service account holds. These report facts; `../rules/build-warrant` turns them into a verdict.
 */

export interface ResolvePreviewTargetInput {
    branchId: string;
    headSha: string;
}

export interface ResolvePreviewTargetOutput {
    /** The branch's owning organization, absent only when the branch resolves to no application. */
    organizationId?: string;
    /** Absent when the customer deploys their own preview, or the repo is not onboarded far enough to have one. */
    target?: PreviewDeployTarget;
    /**
     * Whether the branch already has a deployment to run tests against. Only meaningful with no `target`: the run
     * cannot produce one itself, so this is what says whether there is anything to analyze against.
     */
    hasRecordedPreview: boolean;
}

export interface HasBranchEverBuiltPreviewInput {
    branchId: string;
}

export interface HasBranchEverBuiltPreviewOutput {
    /** Whether this branch has ever had a live preview. An in-flight build does not count. */
    everBuilt: boolean;
}

export interface LaunchPreviewBuildInput {
    target: PreviewDeployTarget;
}

/**
 * The presence of `declined` is the discriminant. Do not add a flag beside it: a build in flight replays against
 * whatever this type says today, so the launched case has to stay recognisable from `jobName` alone.
 */
export type LaunchPreviewBuildOutput =
    | {
          /**
           * Carried so the build can be cancelled by NAME: the `previewkit.dev/env` label is per (repo, PR), so a
           * label-scoped delete issued after a newer commit launched would kill the newer build.
           */
          jobName: string;
          declined?: undefined;
      }
    | {
          jobName?: undefined;
          /** Why no preview is coming. */
          declined: string;
      };

export interface CancelPreviewBuildInput {
    jobName: string;
}

export interface ReadPreviewBuildJobStateInput {
    jobName: string;
}

/** Mirrors `PreviewDeployJobState` in `@autonoma/k8s/previewkit-jobs`, which workflow code cannot import. */
export type PreviewBuildJobState = "running" | "succeeded" | "failed" | "gone";

export interface ReadPreviewBuildJobStateOutput {
    state: PreviewBuildJobState;
}

export interface ReadPreviewBuildStatusInput {
    repoFullName: string;
    prNumber: number;
    /** The commit this flow is building. The environment row counts only once it carries this head. */
    headSha: string;
}

/**
 * - `missing`: nothing recorded for this commit YET, and never terminal - a declined deploy writes no row either,
 *   so only {@link PreviewBuildJobState} separates the two.
 * - `building`: at our head, not settled. `ready` / `failed`: terminal for our head.
 * - `superseded`: a newer commit took the environment over. A fact, not a guess - the drained pod writes it.
 */
export type PreviewBuildState = "missing" | "building" | "ready" | "failed" | "superseded";

export interface ReadPreviewBuildStatusOutput {
    state: PreviewBuildState;
    /** The preview origin the tests browse. Present only when `ready`. */
    primaryUrl?: string;
    /** Origin of the app hosting the Environment Factory handler, when the config declares one. */
    sdkAppUrl?: string;
    /** The recorded failure, when `failed` or `superseded`. */
    error?: string;
}

export interface AttachPreviewDeploymentInput {
    branchId: string;
    organizationId: string;
    /** The preview origin the branch's tests run against. */
    url: string;
    /** Origin of the app hosting the Environment Factory handler. Falls back to `url` when absent. */
    sdkAppUrl?: string;
}

export interface AttachPreviewDeploymentOutput {
    deploymentId: string;
}

/** The first five stand on their own; the last three are the verdict impact analysis reached. */
export type PreviewBuildWarrantReason =
    | "main_branch_preview"
    | "branch_not_resolvable"
    | "head_already_analyzed"
    | "branch_already_previewed"
    | "force_build"
    | "analysis_selected_tests"
    | "no_test_work"
    | "analysis_indeterminate";

export interface ReportPreviewBuildWarrantInput {
    organizationId: string;
    repoFullName: string;
    prNumber: number;
    headSha: string;
    branchId?: string;
    snapshotId?: string;
    /** Whether a build follows is DERIVED from this, via `warrantsBuild`, so the two can never disagree. */
    reason: PreviewBuildWarrantReason;
    /** How many web investigation targets impact analysis selected, when it got that far. */
    targetCount?: number;
}

export interface PreviewkitActivities {
    resolvePreviewTarget(input: ResolvePreviewTargetInput): Promise<ResolvePreviewTargetOutput>;
    hasBranchEverBuiltPreview(input: HasBranchEverBuiltPreviewInput): Promise<HasBranchEverBuiltPreviewOutput>;
    launchPreviewBuild(input: LaunchPreviewBuildInput): Promise<LaunchPreviewBuildOutput>;
    cancelPreviewBuild(input: CancelPreviewBuildInput): Promise<void>;
    readPreviewBuildJobState(input: ReadPreviewBuildJobStateInput): Promise<ReadPreviewBuildJobStateOutput>;
    readPreviewBuildStatus(input: ReadPreviewBuildStatusInput): Promise<ReadPreviewBuildStatusOutput>;
    attachPreviewDeployment(input: AttachPreviewDeploymentInput): Promise<AttachPreviewDeploymentOutput>;
    reportPreviewBuildWarrant(input: ReportPreviewBuildWarrantInput): Promise<void>;
}
