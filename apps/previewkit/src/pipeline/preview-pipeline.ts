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
import type { StorageProvider } from "@autonoma/storage";
import type { AddonManager, AddonProvisionOutcome } from "../addons/addon-manager";
import { BuildError, type Builder } from "../builder/builder";
import { loadPreviewConfig } from "../config/file";
import { loadActiveConfig, loadConfigRevision } from "../config/revisions";
import type { BranchConvention, PreviewConfig, RepoDependency } from "../config/schema";
import {
    type AppBuildOutcome,
    isGithubFeedbackEnabledForOrg,
    recordBuildFinished,
    recordEnvironmentCreated,
    recordEnvironmentManifest,
    recordEnvironmentReady,
    recordPhaseChanged,
    recordResolvedConfig,
    toAppInstances,
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
 * How long the "view logs" links in the PR comment stay valid. Build logs live
 * in a private S3 bucket, so the comment links must be presigned to open from a
 * browser without AWS credentials. 7 days is the maximum a SigV4 presigned URL
 * can last; we use the full window so the link survives a PR sitting open for a
 * while. The link is re-signed every time the comment is updated (each push).
 */
const BUILD_LOG_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Combined per-app outcome rendered in the PR comment. Bundles the build and
 * deploy phases so the comment can show one row per app with the final status.
 */
interface AppFinalOutcome {
    name: string;
    status: "ok" | "failed";
    url?: string;
    error?: string;
    buildLogUrl?: string;
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
}

interface DependencyEntry {
    dep: RepoDependency;
    config: PreviewConfig;
    tmpDir: string;
    usedFallback: boolean;
    targetBranch: string;
}

interface PreviewPipelineOptions {
    provider: GitProvider;
    builder: Builder;
    deployer: Deployer;
    awsSecretsFetcher: AwsSecretsFetcher;
    addonManager: AddonManager;
    registryUrl: string;
    storage: StorageProvider;
}

/** Per-deploy options layered on top of the GitHub event. */
export interface DeployOptions {
    /** Pin the primary app's config to a specific revision (e.g. redeploy reproducing
     *  the topology a PR was originally deployed with) instead of the Application's
     *  current active revision. A pinned id that no longer resolves degrades to the
     *  current config. */
    configRevisionId?: string | undefined;
}

export class PreviewPipeline {
    private readonly provider: GitProvider;
    private readonly builder: Builder;
    private readonly deployer: Deployer;
    private readonly awsSecretsFetcher: AwsSecretsFetcher;
    private readonly addonManager: AddonManager;
    private readonly registryUrl: string;
    private readonly storage: StorageProvider;

    constructor(options: PreviewPipelineOptions) {
        this.provider = options.provider;
        this.builder = options.builder;
        this.deployer = options.deployer;
        this.awsSecretsFetcher = options.awsSecretsFetcher;
        this.addonManager = options.addonManager;
        this.registryUrl = options.registryUrl;
        this.storage = options.storage;
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

    async deploy(event: PullRequestEvent, options?: DeployOptions): Promise<void> {
        const { repoFullName, prNumber, headSha, organizationId, githubRepositoryId } = event;
        const shortSha = headSha.slice(0, 7);

        logger.info("Starting preview deployment", { repo: repoFullName, pr: prNumber, sha: shortSha });

        // 1. Confirm the repo is linked to an Application (the user's opt-in signal).
        //    Many repos under an installed GitHub App will never have one; we want
        //    those PRs to be silently ignored rather than spammed with failed statuses.
        //    Done first because it's a cheap local DB query and short-circuits before
        //    we pay for the GitHub API call below.
        const application = await db.application.findUnique({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId } },
            select: {
                id: true,
                previewkitSecrets: { select: { appName: true, awsSecretArn: true } },
            },
        });
        if (application == null) {
            logger.info("Repo not linked to an Application; skipping deployment", {
                repo: repoFullName,
                pr: prNumber,
                organizationId,
                githubRepositoryId,
            });
            return;
        }

        // 2. Resolve the primary app's config: the Application's active DB config
        //    revision if it has one, else a fallback to the repo's `.preview.yaml`
        //    at the deployed commit (for repos that haven't adopted server-side
        //    config yet). Neither present is the opt-out signal: skip cleanly.
        const resolved = await this.resolvePrimaryConfig(
            application.id,
            repoFullName,
            headSha,
            options?.configRevisionId,
        );
        if (resolved == null) {
            logger.warn("No active config revision and no .preview.yaml; skipping deployment", {
                repo: repoFullName,
                pr: prNumber,
                sha: shortSha,
            });
            return;
        }
        const primaryConfig = resolved.config;
        const configRevisionId = resolved.revisionId;

        // 1c. Per-org toggle: when false, the pipeline still runs end-to-end but stays quiet on GitHub.
        // Synthetic non-PR environments (currently prNumber 0 for an Application's main branch)
        // are always quiet because there is no PR thread to comment on.
        const feedbackEnabled = prNumber > 0 && (await isGithubFeedbackEnabledForOrg(organizationId));
        if (!feedbackEnabled) {
            logger.info("GitHub feedback disabled for deployment; skipping comments + commit statuses", {
                organizationId,
                repo: repoFullName,
                pr: prNumber,
            });
        }

        // 2. Set commit status to pending
        if (feedbackEnabled) {
            await this.provider.setCommitStatus(repoFullName, headSha, "pending", "Building preview environment...");
        }

        // 3. Reuse the existing PR comment if one was created on a previous push.
        //    A single PR has exactly one comment that gets edited through every
        //    push and through teardown — no comment-spam on PR conversations
        //    that get many pushes. On the very first deploy this falls through
        //    to postComment; on subsequent deploys it updates in place.
        let commentId = "";
        if (feedbackEnabled) {
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

        // 4. Ensure namespace exists so status can be polled from the first moment
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

        // recordEnvironmentCreated runs through recordSafe (DB errors don't
        // fail the deploy). For addon provisioning we need the env row's id,
        // so look it up explicitly — if the earlier upsert was swallowed,
        // we'll fall back to skipping addon provisioning rather than
        // failing the whole deploy.
        const environmentRow = await db.previewkitEnvironment.findUnique({
            where: { namespace },
            select: { id: true },
        });

        let primaryDir: string | undefined;
        let dependencyEntries: DependencyEntry[] = [];
        let addonOutcomes: AddonProvisionOutcome[] = [];
        let addonOutputs: AddonOutputs = {};

        try {
            // 5. Clone the primary repo and all dependency repos in parallel.
            await this.updatePhase(repoFullName, prNumber, "pending", "cloning");
            primaryDir = await mkdtemp(path.join(os.tmpdir(), `previewkit-${prNumber}-`));
            const deps = primaryConfig.config?.multirepo?.repos ?? [];
            const convention = primaryConfig.config?.multirepo?.branch_convention;
            const [dependencyResults] = await Promise.all([
                Promise.all(deps.map((dep) => this.cloneDependency(dep, prNumber, event.headRef, convention))),
                this.provider.fetchRepoTarball(repoFullName, headSha, primaryDir),
            ]);
            dependencyEntries = dependencyResults.filter((e): e is DependencyEntry => e != null);

            // 6. Merge all configs into a single config for building and deploying.
            const mergedConfig = this.mergeConfigs(primaryConfig, dependencyEntries);
            await recordSafe(() => recordEnvironmentManifest(namespace, mergedConfig));

            // Snapshot the effective (merged) config onto the environment so a
            // re-deploy of this PR reproduces the same topology. configRevisionId
            // records which primary revision fed it.
            await recordSafe(() => recordResolvedConfig({ namespace, resolvedConfig: mergedConfig, configRevisionId }));

            // 7. Build appRepoDirs: maps each app name to the directory it should be built from.
            const appRepoDirs = new Map<string, string>();
            for (const app of primaryConfig.apps) {
                appRepoDirs.set(app.name, primaryDir);
            }
            for (const entry of dependencyEntries) {
                for (const app of entry.config.apps) {
                    appRepoDirs.set(app.name, entry.tmpDir);
                }
            }

            // 8. Provision third-party addons (Neon branches, etc.). Each
            //      addon is its own failure domain — one bad addon does not
            //      abort the build. Successful outputs flow into build_args
            //      and runtime env via {{addonName.<key>}} templates. Apps
            //      whose templates reference a failed addon will themselves
            //      fail at template-resolve time, which the per-app status
            //      table already surfaces cleanly.
            if (mergedConfig.addons.length > 0) {
                await this.updatePhase(repoFullName, prNumber, "pending", "provisioning-addons");
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
            // 8. Build all app images in parallel. Per-app build failures are
            //    captured into the outcome map rather than thrown — only the
            //    "every app failed" case aborts the pipeline as a global error.
            await this.updatePhase(repoFullName, prNumber, "building", "building-images");
            const buildStart = Date.now();
            const arnByApp = new Map<string, string>();
            for (const s of application.previewkitSecrets) {
                if (s.appName != null) arnByApp.set(s.appName, s.awsSecretArn);
            }
            logger.info("Resolved Application for build", {
                repo: repoFullName,
                pr: prNumber,
                applicationId: application.id,
                registeredSecretApps: [...arnByApp.keys()].sort(),
            });
            logger.info("AWS secret ARNs by app", {
                apps: Object.fromEntries(arnByApp),
                registeredApps: [...arnByApp.keys()],
                totalSecretRegistrations: arnByApp.size,
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

            if (allBuildsFailed) {
                throw new Error("All app builds failed; see per-app build outcomes for details");
            }

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

            // 10. Deploy services (postgres, redis, etc.) and wait for readiness.
            //     App pods have not started yet at this point.
            await this.updatePhase(repoFullName, prNumber, "deploying", "deploying-services");
            const infraResult = await this.deployer.deployInfra(deployOpts);

            // 11. Pre-deploy hooks (e.g. Postgres schema creation). Services are
            //     up; app pods have not started yet, so there is no CrashLoopBackOff
            //     race: schemas exist before any app tries to connect.
            await this.updatePhase(repoFullName, prNumber, "deploying", "pre-deploy-hooks");
            await this.runPreDeployHooks(
                mergedConfig,
                infraResult.namespace,
                repoFullName,
                prNumber,
                imageTags,
                addonOutputs,
            );

            // 12. Deploy apps wave by wave. Each app is its own failure domain.
            await this.updatePhase(repoFullName, prNumber, "deploying", "deploying-apps");
            const result = await this.deployer.deployApps(deployOpts, infraResult);

            // 13. Collect apps that are ready now (for post_deploy hook filtering).
            //     Apps in CrashLoopBackOff are not in this set and their own
            //     hooks are skipped — but proxy hooks (e.g. running another
            //     service's migration from a sibling pod) still run.
            const readyAppNamesForHooks = new Set(
                Object.entries(result.appOutcomes)
                    .filter(([_, o]) => o.status === "ok")
                    .map(([n]) => n),
            );

            // 14. Run post-deploy hooks only for apps that came up. Hooks that
            //     target a failed app would fail at `kubectl exec` time with
            //     "no pod" — better to skip silently than poison the pipeline.
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

            // 15. Restart any apps that crashed during startup with CrashLoopBackOff.
            //     Post_deploy hooks above typically run migrations — deleting the
            //     crashing pods lets them restart immediately (bypassing exponential
            //     backoff) with the schema changes already in place.
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

            // 16. Aggregate per-app outcomes for downstream reporting + decisions.
            //     Re-computed after crash recovery so recovered apps show as ok.
            const finalOutcomes = this.computeFinalOutcomes(mergedConfig, appBuilds, result.appOutcomes);
            const readyAppNames = new Set(finalOutcomes.filter((o) => o.status === "ok").map((o) => o.name));
            const readyCount = readyAppNames.size;
            const totalCount = finalOutcomes.length;

            // 14. If nothing came up, treat as a global failure. Otherwise mark
            //     the env ready — a partial preview is still useful.
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
                    namespace,
                    urls: result.urls,
                    apps: toAppInstances(mergedConfig.apps, imageTags, readyAppNames),
                    bypassToken: result.bypassToken,
                }),
            );

            // 14. Update PR comment with per-app status table.
            if (feedbackEnabled && commentId !== "") {
                const fallbackDeps = dependencyEntries.filter((e) => e.usedFallback);
                await postOrUpdateCommentOnGithub({
                    client: this.provider,
                    store: createPreviewkitCommentStore(db),
                    repoFullName,
                    prNumber,
                    lastCommitSha: headSha,
                    commentId,
                    payload: await this.buildPreviewResultPayload(
                        prNumber,
                        headSha,
                        finalOutcomes,
                        mergedConfig,
                        readyCount,
                        totalCount,
                        fallbackDeps,
                        addonOutcomes,
                    ),
                });
            }

            const allReady = readyCount === totalCount;

            // 15. Single global commit status. Success only when every app
            //     came up; otherwise failure with an "N/M ready" description.
            //     Per-app contexts (`previewkit/<app>`) are a Stage B follow-up.
            if (feedbackEnabled) {
                const firstReadyUrl = finalOutcomes.find((o) => o.status === "ok")?.url;
                await this.provider.setCommitStatus(
                    repoFullName,
                    headSha,
                    allReady ? "success" : "failure",
                    allReady ? "Preview environment ready" : `${readyCount}/${totalCount} apps ready`,
                    firstReadyUrl,
                );
            }

            // 16. Create GitHub Deployment so trigger-diffs.yml fires and runs diffs analysis.
            try {
                const primaryUrl = resolvePrimaryUrl(primaryConfig.apps, result.urls);
                if (primaryUrl == null) {
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
                    allReady ? "success" : "failure",
                    primaryUrl,
                    allReady ? "Preview environment ready" : `${readyCount}/${totalCount} apps ready`,
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
                readyCount,
                totalCount,
                urls: result.urls,
            });
        } catch (err) {
            logger.error("Preview deployment failed", err, { repo: repoFullName, pr: prNumber });

            const message = err instanceof Error ? err.message : "Unknown error";
            await this.deployer
                .updateStatus(repoFullName, prNumber, {
                    status: "failed",
                    phase: "failed",
                    error: message,
                })
                .catch((e) => logger.error("Failed to record failed status", e));

            await recordSafe(() =>
                recordPhaseChanged({
                    namespace,
                    status: "failed",
                    phase: "failed",
                    error: message,
                }),
            );

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
                        details: [
                            {
                                summary: "Preview deployment error",
                                body: err instanceof Error ? err.message : "Unknown error occurred",
                            },
                        ],
                    }),
                }).catch((e) => logger.error("Failed to update failure comment", e));
            }

            if (feedbackEnabled) {
                await this.provider
                    .setCommitStatus(repoFullName, headSha, "failure", "Preview deployment failed")
                    .catch((e) => logger.error("Failed to set failure status", e));
            }

            throw err;
        } finally {
            const dirsToClean = [primaryDir, ...dependencyEntries.map((e) => e.tmpDir)].filter((d) => d != null);
            await Promise.all(dirsToClean.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
        }
    }

    // Resolves the target branch, fetches the .preview.yaml, and clones the repo into a temp dir.
    // Returns null if no .preview.yaml is found on either the resolved branch or the fallback (opt-out).
    private async cloneDependency(
        dep: RepoDependency,
        prNumber: number,
        headRef: string,
        convention: BranchConvention | undefined,
    ): Promise<DependencyEntry | null> {
        const targetBranch = resolveTargetBranch(headRef, convention, dep.fallback_branch);

        let config = await loadPreviewConfig(this.provider, dep.repo, targetBranch);
        let branch = targetBranch;
        let usedFallback = false;

        if (config == null && targetBranch !== dep.fallback_branch) {
            config = await loadPreviewConfig(this.provider, dep.repo, dep.fallback_branch);
            branch = dep.fallback_branch;
            usedFallback = true;
        }

        if (config == null) {
            logger.warn("No .preview.yaml found for dependency repo, skipping", {
                name: dep.name,
                repo: dep.repo,
                targetBranch,
                fallbackBranch: dep.fallback_branch,
            });
            return null;
        }

        const tmpDir = await mkdtemp(path.join(os.tmpdir(), `previewkit-${prNumber}-${dep.name}-`));
        await this.provider.fetchRepoTarball(dep.repo, branch, tmpDir);
        logger.info("Cloned dependency repo", { name: dep.name, repo: dep.repo, branch, usedFallback });
        return { dep, config, tmpDir, usedFallback, targetBranch };
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
        // never throws, so we don't need allSettled here.
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
                    `App "${app.name}" declares build_secrets but no PreviewkitSecret row exists for it under applicationId=${ctx.applicationId}. ` +
                        `Registered appNames for this Application: ${registeredList}. ` +
                        `If your secrets are attached to a different Application row (e.g. one without a github_repository_id), point them at ${ctx.applicationId} instead - that's the Application linked to this GitHub repo. ` +
                        `Otherwise upsert a secret via PUT /v1/secrets/${ctx.applicationId}/${app.name}.`,
                );
            }

            const imageTag = `${ctx.registry}/${ctx.org}/${ctx.repo}:${app.name}-pr-${ctx.prNumber}-${ctx.shortSha}`;
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
                ...(app.monorepo != null ? { monorepoTool: app.monorepo } : {}),
            });

            return {
                status: "success",
                imageTag: result.imageTag,
                durationMs: result.durationMs,
                logUrl: result.logUrl,
                runtime: result.runtime,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const logUrl = err instanceof BuildError ? err.logUrl : undefined;
            logger.error("App build failed", err, { app: app.name, logUrl });
            const outcome: AppBuildOutcome = { status: "failed", durationMs: Date.now() - start, error: message };
            if (logUrl != null) outcome.logUrl = logUrl;
            return outcome;
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
        appBuilds: Record<string, AppBuildOutcome>,
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
                const outcome: AppFinalOutcome = { name: app.name, status: "failed", error: build.error };
                if (build.logUrl != null) outcome.buildLogUrl = build.logUrl;
                return outcome;
            }

            if (deploy == null) {
                return {
                    name: app.name,
                    status: "failed",
                    error: "No deploy outcome recorded",
                    buildLogUrl: build.logUrl,
                };
            }

            if (deploy.status === "ok") {
                return { name: app.name, status: "ok", url: deploy.url, buildLogUrl: build.logUrl };
            }

            if (deploy.status === "skipped") {
                return {
                    name: app.name,
                    status: "failed",
                    error: `Deploy skipped: ${deploy.reason}`,
                    buildLogUrl: build.logUrl,
                };
            }

            return {
                name: app.name,
                status: "failed",
                url: deploy.url,
                error: deploy.error,
                buildLogUrl: build.logUrl,
            };
        });
    }

    /**
     * Presign a build log's S3 URL so the "view logs" link in the PR comment
     * opens in a browser without AWS credentials. Build logs are stored as
     * `s3://bucket/key`, which is not browser-openable on its own. Signing is
     * best-effort: a failure drops just that one link rather than failing the
     * whole comment update.
     */
    private async signBuildLogUrl(buildLogUrl: string | undefined, appName: string): Promise<string | undefined> {
        if (buildLogUrl == null || buildLogUrl === "") return undefined;

        try {
            return await this.storage.getSignedUrl(buildLogUrl, BUILD_LOG_URL_TTL_SECONDS);
        } catch (err) {
            logger.warn("Failed to presign build log URL for PR comment", { app: appName, buildLogUrl, err });
            return undefined;
        }
    }

    private async buildPreviewResultPayload(
        prNumber: number,
        headSha: string,
        outcomes: AppFinalOutcome[],
        config: PreviewConfig,
        readyCount: number,
        totalCount: number,
        fallbackDeps: DependencyEntry[],
        addonOutcomes: AddonProvisionOutcome[],
    ) {
        const allReady = readyCount === totalCount;
        const services = await Promise.all(
            outcomes.map(async (outcome) => ({
                name: outcome.name,
                status: outcome.status === "ok" ? ("ready" as const) : ("failed" as const),
                url: outcome.url,
                logsUrl: await this.signBuildLogUrl(outcome.buildLogUrl, outcome.name),
                error: outcome.error,
            })),
        );

        const addons = addonOutcomes.map((outcome) => {
            const addon = config.addons.find((candidate) => candidate.name === outcome.name);
            return {
                name: outcome.name,
                provider: addon?.provider ?? "unknown",
                status: outcome.status === "ok" ? ("ready" as const) : ("failed" as const),
            };
        });

        // Plain text; markdown.ts escapes these when rendering the warnings callout.
        const warnings = fallbackDeps.map(
            (entry) =>
                `${entry.dep.repo} branch ${entry.targetBranch} not found; used ${entry.dep.fallback_branch} instead.`,
        );

        const serviceErrorDetails = services
            .filter((service) => service.error != null && service.error !== "")
            .map((service) => ({ summary: `${service.name} - error`, body: service.error! }));
        const addonErrorDetails = addonOutcomes
            .filter(
                (outcome): outcome is Extract<AddonProvisionOutcome, { status: "failed" }> =>
                    outcome.status === "failed",
            )
            .map((outcome) => ({ summary: `${outcome.name} (addon) - error`, body: outcome.error }));

        return payloadBuilder({
            state: allReady ? "running" : "critical",
            prNumber,
            commitSha: headSha,
            assetBaseUrl: resolvePreviewkitCommentAssetBaseUrl(),
            previewUrl: outcomes.find((outcome) => outcome.status === "ok")?.url,
            message: allReady
                ? "Preview is ready. Autonoma can run the selected tests against this commit."
                : `${readyCount}/${totalCount} preview services are ready. Autonoma cannot run the full sweep yet.`,
            services,
            addons,
            warnings,
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
