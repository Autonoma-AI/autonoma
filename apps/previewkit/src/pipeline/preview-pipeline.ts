import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db, type PrismaClient } from "@autonoma/db";
import {
    type GitHubCommentStore,
    payloadBuilder,
    postOrUpdateCommentOnGithub,
    resolveCommentAssetBaseUrl,
} from "@autonoma/github/comment";
import type { BuildLogSink } from "@autonoma/logger/build-log-sink";
import type { StorageProvider } from "@autonoma/storage";
import type {
    BuildPreviewImagesOutput,
    DeployPreviewEnvironmentInput,
    DeployPreviewEnvironmentOutput,
    PreviewAddonResult,
    PreviewBuildOutcome,
    PreviewServiceResult,
} from "@autonoma/workflow/activities";
import type { AddonManager, AddonProvisionOutcome } from "../addons/addon-manager";
import { BuildAbortedError, type Builder } from "../builder/builder";
import { buildPreviewImageReference } from "../builder/image-reference";
import { resolveDependencyConfig } from "../config/dependency-config";
import { loadPreviewConfig } from "../config/file";
import { loadActiveConfig, loadConfigRevision } from "../config/revisions";
import {
    type BranchConvention,
    type PreviewConfig,
    type RepoDependency,
    trustedPreviewConfigSchema,
} from "../config/schema";
import {
    type AppBuildOutcome,
    type AppStateUpdate,
    recordAppsPending,
    recordAppStates,
    recordBuildFinished,
    recordEnvironmentCreated,
    recordEnvironmentManifest,
    recordEnvironmentReady,
    recordPhaseChanged,
    recordResolvedConfig,
} from "../db";
import type { AppDeployOutcome, DeployResult, Deployer } from "../deployer/deployer";
import { type AddonOutputs, type EnvInjector, type PublicUrlInfo } from "../deployer/env-injector";
import { runHookJob } from "../deployer/hook-job-runner";
import { execInDeploymentPod } from "../deployer/pod-exec";
import { resolvePrimaryUrl } from "../diffs/resolve-primary-url";
import { env } from "../env";
import type { PullRequestEvent } from "../git-provider/git-provider";
import type { GitProvider } from "../git-provider/git-provider";
import { logger } from "../logger";
import { resolveTargetBranch } from "../multirepo/resolve-target-branch";
import type { AwsSecretsFetcher } from "../secrets/aws-secrets-fetcher";

/**
 * Combined per-app outcome rendered in the PR comment. Bundles the build and
 * deploy phases so the comment can show one row per app with the final status.
 */
interface AppFinalOutcome {
    name: string;
    status: "ok" | "failed";
    url?: string;
    error?: string;
}

/**
 * Shared input to every per-app build. Computed once at the top of
 * `buildAllApps` and passed unchanged into each `buildOneApp` invocation —
 * the per-app value (`app`) is the only parameter that varies across builds.
 */
interface AppBuildContext {
    config: PreviewConfig;
    appRepoDirs: Map<string, string>;
    arnByApp: Map<string, string>;
    applicationId: string;
    envInjector: EnvInjector;
    namespace: string;
    templateContext: { pr: string; namespace: string; owner: string };
    publicUrlInfo: PublicUrlInfo;
    // Successfully provisioned addon outputs, available to `build_args` via
    // `{{addonName.<key>}}` templates. Empty if the env declares no addons.
    addonOutputs: AddonOutputs;
    registry: string;
    org: string;
    repo: string;
    prNumber: number;
    shortSha: string;
    // Aborts the in-flight buildctl when the deploy is superseded/cancelled.
    signal?: AbortSignal;
}

interface DependencyEntry {
    dep: RepoDependency;
    config: PreviewConfig;
    tmpDir: string;
    usedFallback: boolean;
    targetBranch: string;
    /** Where the dependency's config came from: a dashboard-authored DB revision or its repo-committed `.preview.yaml`. */
    source: "revision" | "file";
}

interface PreviewPipelineOptions {
    provider: GitProvider;
    builder: Builder;
    deployer: Deployer;
    awsSecretsFetcher: AwsSecretsFetcher;
    addonManager: AddonManager;
    registryUrl: string;
    storage: StorageProvider;
    /** Build-log sink. When set, the pipeline mirrors phase transitions +
     *  terminal status into it (the builder mirrors raw output), keyed by
     *  namespace. Optional - absent disables mirroring entirely. */
    logSink?: BuildLogSink;
}

/**
 * Result of {@link PreviewPipeline.prepare}. `skipped` short-circuits the rest
 * of the pipeline for repos that opted out (no active config revision / no
 * `.preview.yaml`).
 */
export type PreparePreviewResult =
    | { skipped: true }
    | { skipped: false; namespace: string; commentId: string; feedbackEnabled: boolean };

export class PreviewPipeline {
    private readonly provider: GitProvider;
    private readonly builder: Builder;
    private readonly deployer: Deployer;
    private readonly awsSecretsFetcher: AwsSecretsFetcher;
    private readonly addonManager: AddonManager;
    private readonly registryUrl: string;
    private readonly storage: StorageProvider;
    private readonly logSink?: BuildLogSink;

    constructor(options: PreviewPipelineOptions) {
        this.provider = options.provider;
        this.builder = options.builder;
        this.deployer = options.deployer;
        this.awsSecretsFetcher = options.awsSecretsFetcher;
        this.addonManager = options.addonManager;
        this.registryUrl = options.registryUrl;
        this.storage = options.storage;
        this.logSink = options.logSink;
    }

    /**
     * Resolves the primary app's config: the Application's active DB config revision
     * if it has one, otherwise a fallback to the repo's `.preview.yaml` at the
     * deployed commit (so repos that haven't adopted server-side config keep working).
     * Returns undefined when neither exists - the opt-out signal. `revisionId` is
     * undefined for the file fallback: there is no stored revision to pin the snapshot to.
     */
    private async resolvePrimaryConfig(
        applicationId: string,
        repoFullName: string,
        ref: string,
        pinnedRevisionId: string | undefined,
    ): Promise<{ config: PreviewConfig; revisionId: string | undefined } | undefined> {
        // Redeploy pins the revision the environment was originally deployed with, so a
        // change to the Application's active config afterwards doesn't alter a redeploy's
        // topology. A pinned id that no longer resolves degrades to the current config.
        if (pinnedRevisionId != null) {
            const pinned = await loadConfigRevision(applicationId, pinnedRevisionId);
            if (pinned != null) {
                return { config: pinned.config, revisionId: pinned.revisionId };
            }
            logger.warn("Pinned config revision not found; resolving current config", {
                applicationId,
                pinnedRevisionId,
            });
        }

        const active = await loadActiveConfig(applicationId);
        if (active != null) {
            return { config: active.config, revisionId: active.revisionId };
        }

        const fileConfig = await loadPreviewConfig(this.provider, repoFullName, ref);
        if (fileConfig == null) return undefined;

        logger.info("No active config revision; falling back to .preview.yaml", { applicationId, repoFullName, ref });
        return { config: fileConfig, revisionId: undefined };
    }

    /**
     * Step 1 - resolve the Application + config (active revision or `.preview.yaml`),
     * set the initial commit status + PR comment, and ensure the namespace exists so
     * status can be polled from the first moment. Returns `{ skipped: true }` for repos
     * that opted out (not linked, or no active revision / `.preview.yaml`).
     */
    async prepare(event: PullRequestEvent, configRevisionId?: string | undefined): Promise<PreparePreviewResult> {
        const { repoFullName, prNumber, headSha, organizationId, githubRepositoryId } = event;
        const shortSha = headSha.slice(0, 7);

        logger.info("Preparing preview deployment", { repo: repoFullName, pr: prNumber, sha: shortSha });

        const application = await db.application.findUnique({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId } },
            select: { id: true },
        });
        if (application == null) {
            logger.info("Repo not linked to an Application; skipping deployment", {
                repo: repoFullName,
                pr: prNumber,
                organizationId,
                githubRepositoryId,
            });
            return { skipped: true };
        }

        const resolved = await this.resolvePrimaryConfig(application.id, repoFullName, headSha, configRevisionId);
        if (resolved == null) {
            logger.warn("No active config revision and no .preview.yaml; skipping deployment", {
                repo: repoFullName,
                pr: prNumber,
                sha: shortSha,
            });
            return { skipped: true };
        }

        // Synthetic non-PR environments (prNumber 0 for an Application's main branch)
        // stay quiet on GitHub because there is no PR thread to comment on.
        const isPullRequest = prNumber > 0;
        if (!isPullRequest) {
            logger.info("Skipping GitHub comments + commit statuses; deployment is not for a pull request", {
                organizationId,
                repo: repoFullName,
                pr: prNumber,
            });
        }

        if (isPullRequest) {
            await this.provider.setCommitStatus(repoFullName, headSha, "pending", "Building preview environment...");
        }

        let commentId = "";
        if (isPullRequest) {
            const result = await postOrUpdateCommentOnGithub({
                client: this.provider,
                store: createPreviewkitCommentStore(db),
                repoFullName,
                prNumber,
                lastCommitSha: headSha,
                staleGuard: "allow-new-head",
                payload: payloadBuilder({
                    state: "running",
                    prNumber,
                    commitSha: headSha,
                    assetBaseUrl: resolvePreviewkitCommentAssetBaseUrl(),
                    message: "Autonoma received this commit and is building the preview environment.",
                }),
            }).catch((err) => {
                logger.warn("Failed to post or update initial PR comment", {
                    repo: repoFullName,
                    pr: prNumber,
                    err: err instanceof Error ? err.message : String(err),
                });
                return null;
            });

            commentId = result?.status === "posted" || result?.status === "updated" ? result.commentId : "";
        }

        const namespace = await this.deployer.ensureNamespace(repoFullName, prNumber, organizationId, {
            commentId,
            lastDeployedSha: headSha,
            status: "pending",
            phase: "initializing",
        });

        await recordSafe(() =>
            recordEnvironmentCreated({
                repoFullName,
                prNumber,
                headSha,
                headRef: event.headRef,
                namespace,
                organizationId,
                githubRepositoryId,
                commentId,
            }),
        );

        return { skipped: false, namespace, commentId, feedbackEnabled: isPullRequest };
    }

    /**
     * Step 2 - resolve config, clone primary + dependency repos, merge configs,
     * snapshot the resolved config, provision addons (their outputs feed
     * `build_args`), and build every app image to ECR. Temp dirs are cloned and torn
     * down entirely within this step. Throws when every build fails.
     */
    async build(
        event: PullRequestEvent,
        namespace: string,
        configRevisionId?: string | undefined,
        signal?: AbortSignal,
    ): Promise<BuildPreviewImagesOutput> {
        const { repoFullName, prNumber, headSha, organizationId, githubRepositoryId } = event;
        const shortSha = headSha.slice(0, 7);

        const application = await db.application.findUnique({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId } },
            select: { id: true },
        });
        if (application == null) {
            throw new Error(`Application not found for ${repoFullName} (org ${organizationId})`);
        }

        const resolved = await this.resolvePrimaryConfig(application.id, repoFullName, headSha, configRevisionId);
        if (resolved == null) {
            throw new Error(`No active config revision and no .preview.yaml for ${repoFullName} at ${shortSha}`);
        }
        const primaryConfig = resolved.config;
        const resolvedRevisionId = resolved.revisionId;

        let primaryDir: string | undefined;
        let dependencyEntries: DependencyEntry[] = [];

        try {
            await this.updatePhase(repoFullName, prNumber, "pending", "cloning");
            primaryDir = await mkdtemp(path.join(os.tmpdir(), `previewkit-${prNumber}-`));
            const deps = primaryConfig.config?.multirepo?.repos ?? [];
            const convention = primaryConfig.config?.multirepo?.branch_convention;
            const [dependencyResults] = await Promise.all([
                Promise.all(
                    deps.map((dep) => this.cloneDependency(dep, prNumber, event.headRef, convention, organizationId)),
                ),
                this.provider.fetchRepoTarball(repoFullName, headSha, primaryDir),
            ]);
            dependencyEntries = dependencyResults.filter((e): e is DependencyEntry => e != null);

            const mergedConfig = this.mergeConfigs(primaryConfig, dependencyEntries);
            await recordSafe(() => recordEnvironmentManifest(namespace, mergedConfig));
            // Snapshot the effective (merged) config so a re-deploy of this PR
            // reproduces the same topology. configRevisionId records which primary
            // revision fed it (undefined for a .preview.yaml-sourced deploy).
            await recordSafe(() =>
                recordResolvedConfig({ namespace, resolvedConfig: mergedConfig, configRevisionId: resolvedRevisionId }),
            );

            // Moment 0: now that the merged config names every app, seed a
            // `pending` lifecycle row per app so each has a distinct status
            // record from the start (and stale rows from a prior commit are
            // pruned/reset).
            await recordSafe(() =>
                recordAppsPending(
                    namespace,
                    mergedConfig.apps.map((a) => ({ appName: a.name, port: a.port })),
                ),
            );

            const appRepoDirs = new Map<string, string>();
            for (const app of primaryConfig.apps) {
                appRepoDirs.set(app.name, primaryDir);
            }
            for (const entry of dependencyEntries) {
                for (const app of entry.config.apps) {
                    appRepoDirs.set(app.name, entry.tmpDir);
                }
            }

            // Provision addons before building - their outputs flow into build_args
            // + runtime env via {{addonName.<key>}} templates. Each addon is its own
            // failure domain.
            let addonOutcomes: AddonProvisionOutcome[] = [];
            let addonOutputs: AddonOutputs = {};
            if (mergedConfig.addons.length > 0) {
                await this.updatePhase(repoFullName, prNumber, "pending", "provisioning-addons");
                const environmentRow = await db.previewkitEnvironment.findUnique({
                    where: { namespace },
                    select: { id: true },
                });
                if (environmentRow == null) {
                    logger.warn(
                        "Cannot provision addons: PreviewkitEnvironment row missing. " +
                            "Continuing without addon outputs — apps that reference them will fail at template-resolve time.",
                        { namespace, addonNames: mergedConfig.addons.map((a) => a.name) },
                    );
                } else {
                    addonOutcomes = await this.addonManager.provisionAll(
                        environmentRow.id,
                        organizationId,
                        namespace,
                        prNumber,
                        mergedConfig.addons,
                    );
                    addonOutputs = Object.fromEntries(
                        addonOutcomes
                            .filter((o): o is Extract<AddonProvisionOutcome, { status: "ok" }> => o.status === "ok")
                            .map((o) => [o.name, o.outputs]),
                    );
                }
            }

            await this.updatePhase(repoFullName, prNumber, "building", "building-images");
            await recordSafe(() =>
                recordAppStates(
                    namespace,
                    mergedConfig.apps.map((a) => ({ appName: a.name, status: "building", port: a.port })),
                ),
            );
            const buildStart = Date.now();
            // Org-scoped by appName, mirroring AwsExternalSecretManager.applyForNamespace:
            // in multirepo deployments dependency apps' secrets hang off their own
            // Application rows, and app names are unique across the merged topology.
            const secretRecords = await db.previewkitSecret.findMany({
                where: {
                    application: { organizationId },
                    appName: { in: mergedConfig.apps.map((app) => app.name) },
                },
                select: { appName: true, awsSecretArn: true },
            });
            const arnByApp = new Map<string, string>();
            for (const s of secretRecords) arnByApp.set(s.appName, s.awsSecretArn);
            logger.info("Resolved Application for build", {
                repo: repoFullName,
                pr: prNumber,
                applicationId: application.id,
                registeredSecretApps: [...arnByApp.keys()].sort(),
            });
            const appBuilds = await this.buildAllApps(
                mergedConfig,
                appRepoDirs,
                repoFullName,
                prNumber,
                shortSha,
                arnByApp,
                application.id,
                addonOutputs,
                signal,
            );
            const buildDurationMs = Date.now() - buildStart;

            const imageTags: Record<string, string> = {};
            for (const [name, outcome] of Object.entries(appBuilds)) {
                if (outcome.status === "success") imageTags[name] = outcome.imageTag;
            }
            const allBuildsFailed = Object.values(appBuilds).every((o) => o.status === "failed");

            await recordSafe(() =>
                recordBuildFinished({
                    namespace,
                    headSha,
                    status: allBuildsFailed ? "failed" : "building",
                    durationMs: buildDurationMs,
                    appBuilds,
                    error: allBuildsFailed ? "All app builds failed" : undefined,
                }),
            );

            // Transition each app's lifecycle row to `built` (with its imageTag)
            // or `build_failed` (with the error) - the per-app build verdict.
            await recordSafe(() => recordAppStates(namespace, this.toBuildStates(mergedConfig, appBuilds)));

            if (allBuildsFailed) {
                throw new Error("All app builds failed; see per-app build outcomes for details");
            }

            const warnings = dependencyEntries
                .filter((e) => e.usedFallback)
                .map(
                    (entry) =>
                        `${entry.dep.repo} branch ${entry.targetBranch} not found; used ${entry.dep.fallback_branch} instead.`,
                );

            return {
                mergedConfigJson: JSON.stringify(mergedConfig),
                imageTags,
                addonOutputs,
                buildOutcomes: appBuilds,
                addons: this.toAddonResults(mergedConfig, addonOutcomes),
                warnings,
                primaryAppNames: primaryConfig.apps.map((a) => a.name),
            };
        } finally {
            const dirsToClean = [primaryDir, ...dependencyEntries.map((e) => e.tmpDir)].filter((d) => d != null);
            await Promise.all(
                dirsToClean.map((dir) =>
                    rm(dir, { recursive: true, force: true }).catch((err) =>
                        logger.warn("Failed to clean up temp dir", { dir, err }),
                    ),
                ),
            );
        }
    }

    /**
     * Step 3 - deploy infra, run pre-deploy hooks, deploy apps wave-by-wave, run
     * post-deploy hooks, restart crash-looped apps, and mark the env ready. Returns
     * flat, comment-ready result rows. Throws when no app comes up.
     */
    async deployEnvironment(
        input: DeployPreviewEnvironmentInput,
        signal?: AbortSignal,
    ): Promise<DeployPreviewEnvironmentOutput> {
        const { event, commentId, imageTags, addonOutputs, buildOutcomes, addons, warnings, primaryAppNames } = input;
        const { repoFullName, prNumber, headSha, organizationId, githubRepositoryId } = event;
        // Re-hydrate the merged config across the Temporal activity boundary. Each
        // source already had its resource policy applied upstream (a `.preview.yaml`
        // was standardized; a DB revision's overrides were honored), so this re-parse
        // must preserve those values rather than re-standardize them - hence the
        // trusted schema, which passes already-normalized resources through unchanged.
        const mergedConfig = trustedPreviewConfigSchema.parse(JSON.parse(input.mergedConfigJson));

        const deployOpts = {
            repoFullName,
            prNumber,
            headSha,
            organizationId,
            githubRepositoryId,
            config: mergedConfig,
            imageTags,
            addonOutputs,
            commentId,
        };

        // Bail before each long deploy phase if a newer commit superseded this
        // run, so we stop sinking work into an environment the successor owns.
        signal?.throwIfAborted();
        await this.updatePhase(repoFullName, prNumber, "deploying", "deploying-services");
        const infraResult = await this.deployer.deployInfra(deployOpts);

        await this.updatePhase(repoFullName, prNumber, "deploying", "pre-deploy-hooks");
        await this.runPreDeployHooks(
            mergedConfig,
            infraResult.namespace,
            repoFullName,
            prNumber,
            imageTags,
            addonOutputs,
        );

        signal?.throwIfAborted();
        await this.updatePhase(repoFullName, prNumber, "deploying", "deploying-apps");
        // Mark the apps that built (have an image) as `deploying`. Apps whose
        // build failed have no imageTag and stay `build_failed`.
        const deployingStates: AppStateUpdate[] = mergedConfig.apps
            .filter((a) => imageTags[a.name] != null && imageTags[a.name] !== "")
            .map((a) => ({ appName: a.name, status: "deploying", port: a.port, imageTag: imageTags[a.name]! }));
        await recordSafe(() => recordAppStates(infraResult.namespace, deployingStates));
        const result = await this.deployer.deployApps(deployOpts, infraResult);

        const readyAppNamesForHooks = new Set(
            Object.entries(result.appOutcomes)
                .filter(([_, o]) => o.status === "ok")
                .map(([n]) => n),
        );

        await this.updatePhase(repoFullName, prNumber, "deploying", "post-deploy-hooks");
        await this.runPostDeployHooks(
            mergedConfig,
            result,
            readyAppNamesForHooks,
            repoFullName,
            prNumber,
            imageTags,
            addonOutputs,
        );

        const crashedApps = Object.entries(result.appOutcomes).flatMap(([name, o]) => {
            if (o.status === "failed" && o.crashLoopBackOff === true) {
                return [{ name, url: o.url }];
            }
            return [];
        });
        if (crashedApps.length > 0) {
            logger.info("Restarting crash-looped apps after post_deploy hooks", {
                namespace: result.namespace,
                apps: crashedApps.map((a) => a.name),
            });
            const recovered = await this.deployer.restartCrashedApps(result.namespace, crashedApps);
            for (const [name, outcome] of Object.entries(recovered)) {
                result.appOutcomes[name] = outcome;
            }
        }

        const finalOutcomes = this.computeFinalOutcomes(mergedConfig, buildOutcomes, result.appOutcomes);
        const readyAppNames = new Set(finalOutcomes.filter((o) => o.status === "ok").map((o) => o.name));
        const readyCount = readyAppNames.size;
        const totalCount = finalOutcomes.length;

        // Persist the final per-app verdict for every app - ready, deploy_failed,
        // or skipped - before the all-failed guard below, so a built-but-undeployed
        // app is a distinct row even when no app came up at all.
        await recordSafe(() =>
            recordAppStates(
                result.namespace,
                this.toFinalAppStates(mergedConfig, buildOutcomes, result.appOutcomes, imageTags),
            ),
        );

        if (readyCount === 0) {
            throw new Error(`No apps deployed successfully (0/${totalCount}); see per-app outcomes for details`);
        }

        await this.deployer.updateStatus(repoFullName, prNumber, {
            status: "ready",
            phase: "ready",
            urls: result.urls,
        });
        await recordSafe(() =>
            recordEnvironmentReady({
                namespace: result.namespace,
                urls: result.urls,
                bypassToken: result.bypassToken,
            }),
        );
        void this.logSink?.append(result.namespace, { kind: "status", message: "ready" });
        void this.logSink?.seal(result.namespace);

        const services: PreviewServiceResult[] = finalOutcomes.map((o) => {
            const svc: PreviewServiceResult = { name: o.name, status: o.status === "ok" ? "ready" : "failed" };
            if (o.url != null) svc.url = o.url;
            if (o.error != null) svc.error = o.error;
            return svc;
        });

        const primaryApps = mergedConfig.apps.filter((a) => primaryAppNames.includes(a.name));
        const previewUrl = finalOutcomes.find((o) => o.status === "ok")?.url;
        const primaryUrl = resolvePrimaryUrl(primaryApps, result.urls);

        const output: DeployPreviewEnvironmentOutput = {
            ready: readyCount === totalCount,
            readyCount,
            totalCount,
            urls: result.urls,
            services,
            addons,
            warnings,
        };
        if (previewUrl != null) output.previewUrl = previewUrl;
        if (primaryUrl != null) output.primaryUrl = primaryUrl;

        logger.info("Preview environment deployed", {
            repo: repoFullName,
            pr: prNumber,
            readyCount,
            totalCount,
            urls: result.urls,
        });
        return output;
    }

    /**
     * Step 4 - the GitHub side effects that must land: update the PR comment with
     * the per-app status table, set the final commit status, and create the GitHub
     * deployment + deployment status (which triggers diffs).
     */
    async finalize(
        event: PullRequestEvent,
        _namespace: string,
        commentId: string,
        feedbackEnabled: boolean,
        result: DeployPreviewEnvironmentOutput,
    ): Promise<void> {
        const { repoFullName, prNumber, headSha } = event;

        if (feedbackEnabled && commentId !== "") {
            await postOrUpdateCommentOnGithub({
                client: this.provider,
                store: createPreviewkitCommentStore(db),
                repoFullName,
                prNumber,
                lastCommitSha: headSha,
                commentId,
                payload: await this.buildResultPayload(prNumber, headSha, result),
            });
        }

        if (feedbackEnabled) {
            await this.provider.setCommitStatus(
                repoFullName,
                headSha,
                result.ready ? "success" : "failure",
                result.ready ? "Preview environment ready" : `${result.readyCount}/${result.totalCount} apps ready`,
                result.previewUrl,
            );
        }

        try {
            if (result.primaryUrl == null) {
                logger.warn("No primary URL resolved; deployment status will have no environment_url", {
                    repo: repoFullName,
                    pr: prNumber,
                });
            }
            const deploymentId = await this.provider.createDeployment(
                repoFullName,
                event.headRef,
                "preview",
                result.urls,
            );
            await this.provider.createDeploymentStatus(
                repoFullName,
                deploymentId,
                result.ready ? "success" : "failure",
                result.primaryUrl,
                result.ready ? "Preview environment ready" : `${result.readyCount}/${result.totalCount} apps ready`,
            );
        } catch (err) {
            logger.fatal("Failed to create GitHub deployment for diffs trigger", err, {
                repo: repoFullName,
                pr: prNumber,
            });
        }

        logger.info("Preview deployment complete", {
            repo: repoFullName,
            pr: prNumber,
            readyCount: result.readyCount,
            totalCount: result.totalCount,
            urls: result.urls,
        });
    }

    /**
     * Failure finalizer - records the failed status/phase and surfaces the error on
     * the PR comment + commit status. Best-effort: never throws.
     */
    async fail(
        event: PullRequestEvent,
        namespace: string,
        commentId: string,
        feedbackEnabled: boolean,
        error: string,
    ): Promise<void> {
        const { repoFullName, prNumber, headSha } = event;
        logger.error("Preview deployment failed", { repo: repoFullName, pr: prNumber, error });

        await this.deployer
            .updateStatus(repoFullName, prNumber, { status: "failed", phase: "failed", error })
            .catch((e) => logger.error("Failed to record failed status", e));

        await recordSafe(() => recordPhaseChanged({ namespace, status: "failed", phase: "failed", error }));
        void this.logSink?.append(namespace, { kind: "status", message: "failed" });
        void this.logSink?.seal(namespace);

        if (feedbackEnabled && commentId !== "") {
            await postOrUpdateCommentOnGithub({
                client: this.provider,
                store: createPreviewkitCommentStore(db),
                repoFullName,
                prNumber,
                lastCommitSha: headSha,
                commentId,
                payload: payloadBuilder({
                    state: "critical",
                    prNumber,
                    commitSha: headSha,
                    assetBaseUrl: resolvePreviewkitCommentAssetBaseUrl(),
                    message: "Autonoma could not finish building the preview environment.",
                    details: [{ summary: "Preview deployment error", body: error }],
                }),
            }).catch((e) => logger.error("Failed to update failure comment", e));
        }

        if (feedbackEnabled) {
            await this.provider
                .setCommitStatus(repoFullName, headSha, "failure", "Preview deployment failed")
                .catch((e) => logger.error("Failed to set failure status", e));
        }
    }

    private toAddonResults(config: PreviewConfig, addonOutcomes: AddonProvisionOutcome[]): PreviewAddonResult[] {
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

    // Resolves the target branch, resolves the dependency's config (active DB
    // revision first, then `.preview.yaml`), and clones the repo into a temp dir.
    // Returns null when neither config source resolves (opt-out).
    private async cloneDependency(
        dep: RepoDependency,
        prNumber: number,
        headRef: string,
        convention: BranchConvention | undefined,
        organizationId: string,
    ): Promise<DependencyEntry | null> {
        const targetBranch = resolveTargetBranch(headRef, convention, dep.fallback_branch);

        const resolved = await resolveDependencyConfig(this.provider, organizationId, dep, targetBranch);
        if (resolved == null) return null;

        const tmpDir = await mkdtemp(path.join(os.tmpdir(), `previewkit-${prNumber}-${dep.name}-`));
        await this.provider.fetchRepoTarball(dep.repo, resolved.branch, tmpDir);
        logger.info("Cloned dependency repo", {
            name: dep.name,
            repo: dep.repo,
            branch: resolved.branch,
            usedFallback: resolved.usedFallback,
            source: resolved.source,
            revisionId: resolved.revisionId,
        });
        return {
            dep,
            config: resolved.config,
            tmpDir,
            usedFallback: resolved.usedFallback,
            targetBranch,
            source: resolved.source,
        };
    }

    private mergeConfigs(primaryConfig: PreviewConfig, deps: DependencyEntry[]): PreviewConfig {
        return {
            ...primaryConfig,
            apps: [...primaryConfig.apps, ...deps.flatMap((d) => d.config.apps)],
            services: [...primaryConfig.services, ...deps.flatMap((d) => d.config.services)],
            hooks: {
                pre_deploy: [...primaryConfig.hooks.pre_deploy, ...deps.flatMap((d) => d.config.hooks.pre_deploy)],
                post_deploy: [...primaryConfig.hooks.post_deploy, ...deps.flatMap((d) => d.config.hooks.post_deploy)],
            },
        };
    }

    private async buildAllApps(
        config: PreviewConfig,
        appRepoDirs: Map<string, string>,
        repoFullName: string,
        prNumber: number,
        shortSha: string,
        arnByApp: Map<string, string>,
        applicationId: string,
        addonOutputs: AddonOutputs,
        signal?: AbortSignal,
    ): Promise<Record<string, AppBuildOutcome>> {
        const [rawOrg, rawRepo] = repoFullName.split("/");
        const org = rawOrg!.toLowerCase();
        const repo = rawRepo!.toLowerCase();

        // Templating context for build_args. Resolves `{{name.host}}`,
        // `{{name.port}}`, `{{name.url}}`, `{{pr}}`, `{{namespace}}`, `{{owner}}`,
        // and now `{{addonName.<key>}}` for successfully provisioned addons —
        // same grammar the deployer applies to runtime env. The URL form is
        // what makes Vite-baked VITE_*_URL vars point at this PR's specific
        // services (opaque hashed hostname, e.g. `https://a3f8b21c4d9e.preview.autonoma.app`).
        const namespace = this.deployer.getNamespaceName(repoFullName, prNumber);
        const templateContext = { pr: String(prNumber), namespace, owner: org };
        const publicUrlInfo = {
            domain: config.domain ?? this.deployer.getDomain(),
            repoFullName,
            secret: this.deployer.getSecret(),
            prNumber,
        };
        const envInjector = this.deployer.getEnvInjector();
        const registry = config.registry ?? this.registryUrl;

        // Each app is built independently — a failure in one app is captured
        // into its own outcome and does not abort the other builds. `buildOneApp`
        // only throws for a supersede abort (BuildAbortedError), in which case we
        // want the whole build to reject and bail (Promise.all surfaces the
        // first rejection); every other error becomes a failed app outcome.
        // Each build spawns its own ephemeral BuildKit Job, so all builds run
        // fully in parallel — Karpenter scales the node pool as needed.
        const entries = await Promise.all(
            config.apps.map(async (app) => {
                const outcome = await this.buildOneApp(app, {
                    config,
                    appRepoDirs,
                    arnByApp,
                    applicationId,
                    envInjector,
                    namespace,
                    templateContext,
                    publicUrlInfo,
                    addonOutputs,
                    registry,
                    org,
                    repo,
                    prNumber,
                    shortSha,
                    signal,
                });
                return [app.name, outcome] as const;
            }),
        );

        return Object.fromEntries(entries);
    }

    /**
     * Builds one app's image. Catches all failures and returns a structured
     * outcome instead of throwing — the caller relies on this to keep the
     * other apps' builds running when one fails.
     */
    private async buildOneApp(app: PreviewConfig["apps"][number], ctx: AppBuildContext): Promise<AppBuildOutcome> {
        const start = Date.now();
        try {
            if (app.build_secrets.length > 0 && !ctx.arnByApp.has(app.name)) {
                const registered = [...ctx.arnByApp.keys()].sort();
                const registeredList = registered.length > 0 ? registered.join(", ") : "(none)";
                throw new Error(
                    `App "${app.name}" declares build_secrets but no PreviewkitSecret row exists for it in this organization. ` +
                        `Registered appNames across the org: ${registeredList}. ` +
                        `Upsert a secret via PUT /v1/secrets/{applicationId}/${app.name} on the Application that owns this app's repo.`,
                );
            }

            const imageTag = buildPreviewImageReference({
                registry: ctx.registry,
                org: ctx.org,
                repo: ctx.repo,
                appName: app.name,
                prNumber: ctx.prNumber,
                shortSha: ctx.shortSha,
            });
            const dir = ctx.appRepoDirs.get(app.name);
            if (dir == null) throw new Error(`No repo directory found for app "${app.name}"`);
            const contextPath = path.resolve(dir, app.path);
            // Resolve buildContext from explicit override first, then fall back
            // to the cloned repo root when the app declares a monorepo tool.
            // Without an explicit override, a `monorepo: turbo` app must build
            // from the repo root so railpack sees the workspace lockfile.
            const buildContext =
                app.build_context != null
                    ? path.resolve(dir, app.build_context)
                    : app.monorepo != null
                      ? dir
                      : undefined;
            const cacheKey = `${ctx.org}/${ctx.repo}/${app.name}`;

            const appArn = ctx.arnByApp.get(app.name);
            const secretBuildArgs =
                app.build_secrets.length > 0 && appArn != null
                    ? this.awsSecretsFetcher.pickKeys(
                          await this.awsSecretsFetcher.fetchJson(appArn),
                          app.build_secrets,
                          appArn,
                      )
                    : {};

            const mergedBuildArgs: Record<string, string> = { ...secretBuildArgs, ...app.build_args };

            const resolvedBuildArgs = ctx.envInjector.applyTemplates(
                mergedBuildArgs,
                ctx.config.apps,
                ctx.config.services,
                ctx.namespace,
                ctx.templateContext,
                ctx.publicUrlInfo,
                ctx.addonOutputs,
            );

            const result = await this.builder.build({
                appName: app.name,
                contextPath,
                buildContext,
                dockerfile: app.dockerfile,
                buildArgs: resolvedBuildArgs,
                imageTag,
                cacheKey,
                namespace: ctx.namespace,
                ...(app.monorepo != null ? { monorepoTool: app.monorepo } : {}),
                ...(ctx.signal != null ? { signal: ctx.signal } : {}),
            });

            return {
                status: "success",
                imageTag: result.imageTag,
                durationMs: result.durationMs,
                runtime: result.runtime,
            };
        } catch (err) {
            // A supersede abort is not a per-app failure - re-throw so the whole
            // build aborts before `recordBuildFinished` runs, leaving the
            // workflow's `markPreviewDeploySuperseded` as the sole writer of this
            // build row. Every other error is captured as a failed app outcome.
            if (err instanceof BuildAbortedError) {
                throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            logger.error("App build failed", err, { app: app.name });
            return { status: "failed", durationMs: Date.now() - start, error: message };
        }
    }

    private async updatePhase(
        repoFullName: string,
        prNumber: number,
        status: "pending" | "building" | "deploying",
        phase: string,
    ): Promise<void> {
        await this.deployer.updateStatus(repoFullName, prNumber, { status, phase });
        const namespace = this.deployer.getNamespaceName(repoFullName, prNumber);
        await recordSafe(() => recordPhaseChanged({ namespace, status, phase }));
        void this.logSink?.append(namespace, { kind: "phase", message: phase });
    }

    private async runPreDeployHooks(
        config: PreviewConfig,
        namespace: string,
        repoFullName: string,
        prNumber: number,
        imageTags: Record<string, string>,
        addonOutputs: AddonOutputs,
    ): Promise<void> {
        if (config.hooks.pre_deploy.length === 0) return;

        logger.info("Running pre-deploy hooks", { namespace, hooks: config.hooks.pre_deploy.length });

        const kc = this.deployer.getKubeConfig();
        for (const hook of config.hooks.pre_deploy) {
            if (hook.type === "job") {
                const imageTag = imageTags[hook.app];
                if (imageTag == null) {
                    throw new Error(
                        `Pre-deploy hook (type: job) for app "${hook.app}" has no built image — ` +
                            `did the build fail? Available: ${Object.keys(imageTags).join(", ")}`,
                    );
                }
                const appConfig = config.apps.find((a) => a.name === hook.app);
                if (appConfig == null) {
                    throw new Error(`Pre-deploy hook (type: job) references unknown app "${hook.app}"`);
                }
                const org = repoFullName.split("/")[0]!.toLowerCase();
                const context = { pr: String(prNumber), namespace, owner: org };
                const publicUrlInfo = {
                    domain: config.domain ?? this.deployer.getDomain(),
                    repoFullName,
                    secret: this.deployer.getSecret(),
                    prNumber,
                };
                const resolvedEnv = this.deployer
                    .getEnvInjector()
                    .resolve(
                        appConfig.env,
                        config.apps,
                        config.services,
                        namespace,
                        context,
                        publicUrlInfo,
                        addonOutputs,
                    );
                logger.info("Executing pre-deploy hook Job", { app: hook.app, command: hook.command });
                await runHookJob(kc, namespace, hook.app, imageTag, hook.command, resolvedEnv);
            } else {
                logger.info("Executing pre-deploy hook", { app: hook.app, command: hook.command });
                const { stdout, stderr } = await execInDeploymentPod(kc, namespace, hook.app, hook.command);
                if (stdout) logger.info("Pre-deploy hook stdout", { app: hook.app, stdout });
                if (stderr) logger.warn("Pre-deploy hook stderr", { app: hook.app, stderr });
            }
        }
    }

    private async runPostDeployHooks(
        config: PreviewConfig,
        result: DeployResult,
        readyAppNames: Set<string>,
        repoFullName: string,
        prNumber: number,
        imageTags: Record<string, string>,
        addonOutputs: AddonOutputs,
    ): Promise<void> {
        if (config.hooks.post_deploy.length === 0) return;

        const runnable = config.hooks.post_deploy.filter((h) => readyAppNames.has(h.app));
        const skipped = config.hooks.post_deploy.filter((h) => !readyAppNames.has(h.app));
        for (const hook of skipped) {
            logger.info("Skipping post-deploy hook: target app did not come up", {
                app: hook.app,
                command: hook.command,
            });
        }
        if (runnable.length === 0) return;

        logger.info("Running post-deploy hooks", {
            namespace: result.namespace,
            hooks: runnable.length,
        });

        const kc = this.deployer.getKubeConfig();
        for (const hook of runnable) {
            logger.info("Executing post-deploy hook", { app: hook.app, command: hook.command, type: hook.type });
            try {
                if (hook.type === "job") {
                    const imageTag = imageTags[hook.app];
                    if (imageTag == null) {
                        throw new Error(
                            `Post-deploy hook (type: job) for app "${hook.app}" has no built image — ` +
                                `did the build fail? Available: ${Object.keys(imageTags).join(", ")}`,
                        );
                    }
                    const appConfig = config.apps.find((a) => a.name === hook.app);
                    if (appConfig == null) {
                        throw new Error(`Post-deploy hook (type: job) references unknown app "${hook.app}"`);
                    }
                    const org = repoFullName.split("/")[0]!.toLowerCase();
                    const context = { pr: String(prNumber), namespace: result.namespace, owner: org };
                    const publicUrlInfo: PublicUrlInfo = {
                        domain: config.domain ?? this.deployer.getDomain(),
                        repoFullName,
                        secret: this.deployer.getSecret(),
                        prNumber,
                    };
                    const resolvedEnv = this.deployer
                        .getEnvInjector()
                        .resolve(
                            appConfig.env,
                            config.apps,
                            config.services,
                            result.namespace,
                            context,
                            publicUrlInfo,
                            addonOutputs,
                        );
                    await runHookJob(kc, result.namespace, hook.app, imageTag, hook.command, resolvedEnv);
                } else {
                    const { stdout, stderr } = await execInDeploymentPod(kc, result.namespace, hook.app, hook.command);
                    if (stdout) logger.info("Post-deploy hook stdout", { app: hook.app, stdout });
                    if (stderr) logger.warn("Post-deploy hook stderr", { app: hook.app, stderr });
                }
            } catch (err) {
                // Post-deploy hook failures are non-fatal: apps are already running and
                // migrations are typically idempotent (already applied on re-deploys).
                // Log prominently so operators can investigate, but don't abort the deploy.
                logger.error("Post-deploy hook failed (non-fatal)", err, {
                    app: hook.app,
                    command: hook.command,
                });
            }
        }
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
    private computeFinalOutcomes(
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
    private toBuildStates(config: PreviewConfig, appBuilds: Record<string, AppBuildOutcome>): AppStateUpdate[] {
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
    private toFinalAppStates(
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

    /** Builds the PR comment payload from the flat deploy result. */
    private async buildResultPayload(prNumber: number, headSha: string, result: DeployPreviewEnvironmentOutput) {
        const services = result.services.map((service) => ({
            name: service.name,
            status: service.status,
            url: service.url,
            error: service.error,
        }));

        const addons = result.addons.map((addon) => ({
            name: addon.name,
            provider: addon.provider,
            status: addon.status,
        }));

        const serviceErrorDetails = result.services
            .filter((service) => service.error != null && service.error !== "")
            .map((service) => ({ summary: `${service.name} - error`, body: service.error! }));
        const addonErrorDetails = result.addons
            .filter((addon) => addon.status === "failed" && addon.error != null && addon.error !== "")
            .map((addon) => ({ summary: `${addon.name} (addon) - error`, body: addon.error! }));

        return payloadBuilder({
            state: result.ready ? "running" : "critical",
            prNumber,
            commitSha: headSha,
            assetBaseUrl: resolvePreviewkitCommentAssetBaseUrl(),
            previewUrl: result.previewUrl,
            message: result.ready
                ? "Preview is ready. Autonoma can run the selected tests against this commit."
                : `${result.readyCount}/${result.totalCount} preview services are ready. Autonoma cannot run the full sweep yet.`,
            services,
            addons,
            warnings: result.warnings,
            details: [...serviceErrorDetails, ...addonErrorDetails],
        });
    }
}

function resolvePreviewkitCommentAssetBaseUrl(): string {
    return resolveCommentAssetBaseUrl({
        explicitAssetBaseUrl: env.GITHUB_COMMENT_ASSET_BASE_URL,
        appUrl: env.APP_URL,
    });
}

async function recordSafe(fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        logger.error("Failed to record Previewkit DB event", err);
    }
}

// This DB adapter is intentionally duplicated in apps/jobs/run-completion-notification.
// The @autonoma/github package must stay free of an @autonoma/db dependency, so each
// caller owns its store.
function createPreviewkitCommentStore(db: PrismaClient): GitHubCommentStore {
    return {
        async getState(repoFullName, prNumber) {
            const env = await db.previewkitEnvironment.findUnique({
                where: { repoFullName_prNumber: { repoFullName, prNumber } },
                select: { commentId: true, headSha: true },
            });
            return env ?? null;
        },
        async setCommentId(repoFullName, prNumber, commentId) {
            await db.previewkitEnvironment.updateMany({
                where: { repoFullName, prNumber },
                data: { commentId },
            });
        },
    };
}
