import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "@autonoma/db";
import {
    createGitHubPrCommentStore,
    payloadBuilder,
    postOrUpdateCommentOnGithub,
    resolveCommentAssetBaseUrl,
} from "@autonoma/github/comment";
import type { BuildLogSink } from "@autonoma/logger/build-log-sink";
import type {
    BuildPreviewImagesOutput,
    DeployPreviewEnvironmentInput,
    DeployPreviewEnvironmentOutput,
    PreviewServiceResult,
} from "@autonoma/types";
import type { AddonManager, AddonProvisionOutcome } from "../addons/addon-manager";
import { BuildAbortedError, BuildError, type Builder } from "../builder/builder";
import { buildPreviewImageReference } from "../builder/image-reference";
import { resolveDependencyConfig } from "../config/dependency-config";
import { loadConfig } from "../config/load-config";
import {
    type BranchConvention,
    type PreviewConfig,
    type RepoDependency,
    trustedPreviewConfigSchema,
} from "../config/schema";
import {
    type AppBuildOutcome,
    type AppStateUpdate,
    recordAppRedeployOutcome,
    recordAppsPending,
    recordAppStates,
    recordBuildFinished,
    recordEnvironmentCreated,
    recordEnvironmentReady,
    recordPhaseChanged,
    recordResolvedConfig,
} from "../db";
import type { DeployResult, Deployer } from "../deployer/deployer";
import { type AddonOutputs, type EnvInjector, type PublicUrlInfo } from "../deployer/env-injector";
import { runHookJob } from "../deployer/hook-job-runner";
import { resolvePrimaryUrl } from "../diffs/resolve-primary-url";
import { generateDockerfile } from "../dockerfile-builder/generate-dockerfile";
import { resolveBuildTurboFilter } from "../dockerfile-builder/resolve-build-turbo-filter";
import { env } from "../env";
import type { PullRequestEvent } from "../git-provider/git-provider";
import type { GitProvider } from "../git-provider/git-provider";
import { logger } from "../logger";
import { enrichDependencyShas } from "../multirepo/enrich-dependency-shas";
import { resolveTargetBranch } from "../multirepo/resolve-target-branch";
import type { AwsSecretsFetcher } from "../secrets/aws-secrets-fetcher";
import { computeFinalOutcomes, toAddonResults, toBuildStates, toFinalAppStates } from "./outcomes";
import { StatusWriter } from "./status-writer";

/**
 * Shared input to every per-app build. Computed once at the top of
 * `buildAllApps` and passed unchanged into each `buildOneApp` invocation -
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
    /** The concrete commit SHA this dependency was deployed at. */
    sha: string;
}

interface PreviewPipelineOptions {
    provider: GitProvider;
    builder: Builder;
    deployer: Deployer;
    awsSecretsFetcher: AwsSecretsFetcher;
    addonManager: AddonManager;
    registryUrl: string;
    /** ECR pull-through cache prefix for Docker Hub; threaded into generated
     *  Dockerfile base images. "" disables mirroring (see mirrorDockerHubImage). */
    dockerHubMirror: string;
    /** Build-log sink. When set, the pipeline mirrors phase transitions +
     *  terminal status into it (the builder mirrors raw output), keyed by
     *  namespace. Optional - absent disables mirroring entirely. */
    logSink?: BuildLogSink;
}

/**
 * Result of {@link PreviewPipeline.prepare}. `skipped` short-circuits the rest
 * of the pipeline for repos that opted out (no preview config).
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
    private readonly dockerHubMirror: string;
    private readonly logSink?: BuildLogSink;
    private readonly statusWriter: StatusWriter;

    constructor(options: PreviewPipelineOptions) {
        this.provider = options.provider;
        this.builder = options.builder;
        this.deployer = options.deployer;
        this.awsSecretsFetcher = options.awsSecretsFetcher;
        this.addonManager = options.addonManager;
        this.registryUrl = options.registryUrl;
        this.dockerHubMirror = options.dockerHubMirror;
        this.logSink = options.logSink;
        this.statusWriter = new StatusWriter(this.deployer, this.logSink);
    }

    /**
     * Step 1 - resolve the Application + its preview config, set the initial
     * commit status + PR comment, and ensure the namespace exists so status can
     * be polled from the first moment. Returns `{ skipped: true }` for repos
     * that opted out (not linked, or no preview config). Config is latest-only:
     * every deploy and redeploy resolves the Application's current config.
     */
    async prepare(event: PullRequestEvent): Promise<PreparePreviewResult> {
        const { repoFullName, prNumber, headSha, organizationId, githubRepositoryId } = event;
        const shortSha = headSha.slice(0, 7);

        logger.info("Preparing preview deployment", { repo: repoFullName, pr: prNumber, sha: shortSha });

        logger.info("Prepare step 1/6 resolving linked Application", {
            repo: repoFullName,
            pr: prNumber,
            organizationId,
            githubRepositoryId,
        });
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
        logger.info("Prepare step 1/6 resolved linked Application", {
            repo: repoFullName,
            pr: prNumber,
            applicationId: application.id,
        });

        logger.info("Prepare step 2/6 resolving preview config", {
            repo: repoFullName,
            pr: prNumber,
            applicationId: application.id,
        });
        const resolved = await loadConfig(application.id);
        if (resolved == null) {
            logger.warn("No preview config; skipping deployment", {
                repo: repoFullName,
                pr: prNumber,
                sha: shortSha,
            });
            return { skipped: true };
        }
        logger.info("Prepare step 2/6 resolved preview config", {
            repo: repoFullName,
            pr: prNumber,
            applicationId: application.id,
        });

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
            logger.info("Prepare step 3/6 setting initial pending commit status", { repo: repoFullName, pr: prNumber });
            await this.provider.setCommitStatus(repoFullName, headSha, "pending", "Building preview environment...");
            logger.info("Prepare step 3/6 set initial pending commit status", { repo: repoFullName, pr: prNumber });
        }

        let commentId = "";
        if (isPullRequest) {
            logger.info("Prepare step 4/6 posting initial PR comment", { repo: repoFullName, pr: prNumber });
            const result = await postOrUpdateCommentOnGithub({
                client: this.provider,
                store: createGitHubPrCommentStore(db, "preview"),
                repoFullName,
                prNumber,
                lastCommitSha: headSha,
                staleGuard: "allow-new-head",
                // Each deploy reposts a fresh comment at the bottom of the PR; finalize()/fail()
                // then update that same comment in place.
                mode: "repost",
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
            logger.info("Prepare step 4/6 posted initial PR comment", {
                repo: repoFullName,
                pr: prNumber,
                commentId,
            });
        }

        logger.info("Prepare step 5/6 ensuring namespace", { repo: repoFullName, pr: prNumber });
        const namespace = await this.deployer.ensureNamespace(repoFullName, prNumber, organizationId, {
            commentId,
            lastDeployedSha: headSha,
            status: "pending",
            phase: "initializing",
        });
        logger.info("Prepare step 5/6 ensured namespace", { repo: repoFullName, pr: prNumber, namespace });

        logger.info("Prepare step 6/6 recording environment-created event", {
            repo: repoFullName,
            pr: prNumber,
            namespace,
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
                branchId: event.branchId,
            }),
        );
        logger.info("Prepare step 6/6 recorded environment-created event", {
            repo: repoFullName,
            pr: prNumber,
            namespace,
        });

        logger.info("Prepare phase complete", {
            repo: repoFullName,
            pr: prNumber,
            namespace,
            feedbackEnabled: isPullRequest,
        });
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
        signal?: AbortSignal,
        appName?: string | undefined,
    ): Promise<BuildPreviewImagesOutput> {
        const { repoFullName, prNumber, headSha, organizationId, githubRepositoryId } = event;
        const shortSha = headSha.slice(0, 7);

        // Per-app redeploy (rebuild mode): build ONLY this app. The full config is
        // still resolved + merged (build-arg templating needs sibling context) and
        // the full mergedConfig is still returned, but only this app's image is
        // built, only its lifecycle row is touched, and the environment's own
        // status is left untouched (it stays `ready` - siblings keep serving).
        const isScoped = appName != null && appName !== "";

        logger.info("Building preview images", {
            repo: repoFullName,
            pr: prNumber,
            sha: shortSha,
            namespace,
            scopedApp: isScoped ? appName : undefined,
        });

        // Mark the start of this attempt so the log viewer replays only from
        // here - a rerun's output overwrites any prior attempt retained in this
        // namespace's shared Loki stream. Best-effort; never blocks the build.
        void this.logSink?.markStart(namespace);

        logger.info("Build step 1/7 resolving linked Application", {
            repo: repoFullName,
            pr: prNumber,
            organizationId,
            githubRepositoryId,
        });
        const application = await db.application.findUnique({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId } },
            select: { id: true },
        });
        if (application == null) {
            throw new Error(`Application not found for ${repoFullName} (org ${organizationId})`);
        }
        logger.info("Build step 1/7 resolved linked Application", {
            repo: repoFullName,
            pr: prNumber,
            applicationId: application.id,
        });

        logger.info("Build step 2/7 resolving preview config", {
            repo: repoFullName,
            pr: prNumber,
            applicationId: application.id,
        });
        const resolved = await loadConfig(application.id);
        if (resolved == null) {
            throw new Error(`No preview config for ${repoFullName} at ${shortSha}`);
        }
        const primaryConfig = resolved.config;
        logger.info("Build step 2/7 resolved preview config", {
            repo: repoFullName,
            pr: prNumber,
            applicationId: application.id,
        });

        let primaryDir: string | undefined;
        let dependencyEntries: DependencyEntry[] = [];

        try {
            // Skip env-level phase writes when scoped: a per-app rebuild must not
            // flip a live environment's status to pending/building.
            if (!isScoped) await this.statusWriter.updatePhase(repoFullName, prNumber, "pending", "cloning");
            const deps = primaryConfig.config?.multirepo?.repos ?? [];
            logger.info("Build step 3/7 cloning primary + dependency repos", {
                repo: repoFullName,
                pr: prNumber,
                sha: shortSha,
                dependencyCount: deps.length,
            });
            primaryDir = await mkdtemp(path.join(os.tmpdir(), `previewkit-${prNumber}-`));
            const convention = primaryConfig.config?.multirepo?.branch_convention;
            const dependencyConfigByRepo = new Map(
                resolved.dependencyConfigs.map((entry) => [entry.repo, entry.config]),
            );
            const [dependencyResults] = await Promise.all([
                Promise.all(
                    deps.map((dep) =>
                        this.cloneDependency(
                            dep,
                            prNumber,
                            event.headRef,
                            convention,
                            dependencyConfigByRepo.get(dep.repo),
                        ),
                    ),
                ),
                this.provider.fetchRepoTarball(repoFullName, headSha, primaryDir),
            ]);
            dependencyEntries = dependencyResults.filter((e): e is DependencyEntry => e != null);
            logger.info("Build step 3/7 cloned primary + dependency repos", {
                repo: repoFullName,
                pr: prNumber,
                clonedDependencies: dependencyEntries.length,
                skippedDependencies: deps.length - dependencyEntries.length,
            });

            logger.info("Build step 4/7 merging config + snapshotting + seeding app rows", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
            });
            const mergedConfig = this.mergeConfigs(primaryConfig, dependencyEntries);
            if (isScoped && !mergedConfig.apps.some((a) => a.name === appName)) {
                throw new Error(`App "${appName}" not found in resolved config for ${repoFullName} PR ${prNumber}`);
            }
            // The apps to build: just the target when scoped, otherwise every app.
            const buildApps = isScoped ? mergedConfig.apps.filter((a) => a.name === appName) : mergedConfig.apps;
            // Snapshot the effective (merged) config. The summary + readiness views
            // project it for display and failure diagnostics. Overwritten on each
            // deploy once resolved.
            await recordSafe(() => recordResolvedConfig({ namespace, resolvedConfig: mergedConfig }));

            // Moment 0: now that the merged config names every app, seed a
            // `pending` lifecycle row per app so each has a distinct status
            // record from the start (and stale rows from a prior commit are
            // pruned/reset). Skipped when scoped - `recordAppsPending` prunes
            // rows for apps not in the list, which would wipe every sibling; a
            // per-app rebuild touches only the target's row (below).
            if (!isScoped) {
                await recordSafe(() =>
                    recordAppsPending(
                        namespace,
                        mergedConfig.apps.map((a) => ({ appName: a.name, port: a.port })),
                    ),
                );
            }
            logger.info("Build step 4/7 merged config + snapshotted + seeded app rows", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                apps: mergedConfig.apps.map((a) => a.name),
                services: mergedConfig.services.map((s) => s.name),
                addons: mergedConfig.addons.map((a) => a.name),
            });

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
                if (!isScoped)
                    await this.statusWriter.updatePhase(repoFullName, prNumber, "pending", "provisioning-addons");
                logger.info("Build step 5/7 provisioning addons", {
                    repo: repoFullName,
                    pr: prNumber,
                    namespace,
                    addonNames: mergedConfig.addons.map((a) => a.name),
                });
                const environmentRow = await db.previewkitEnvironment.findUnique({
                    where: { namespace },
                    select: { id: true },
                });
                if (environmentRow == null) {
                    logger.warn(
                        "Cannot provision addons: PreviewkitEnvironment row missing. " +
                            "Continuing without addon outputs - apps that reference them will fail at template-resolve time.",
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
                    logger.info("Build step 5/7 provisioned addons", {
                        repo: repoFullName,
                        pr: prNumber,
                        namespace,
                        ok: addonOutcomes.filter((o) => o.status === "ok").map((o) => o.name),
                        failed: addonOutcomes.filter((o) => o.status !== "ok").map((o) => o.name),
                    });
                }
            } else {
                logger.info("Build step 5/7 no addons declared; skipping addon provisioning", {
                    repo: repoFullName,
                    pr: prNumber,
                    namespace,
                });
            }

            if (!isScoped) await this.statusWriter.updatePhase(repoFullName, prNumber, "building", "building-images");
            await recordSafe(() =>
                recordAppStates(
                    namespace,
                    buildApps.map((a) => ({ appName: a.name, status: "building", port: a.port })),
                ),
            );
            const buildStart = Date.now();
            // Scoped to THIS deploy's Application, mirroring
            // AwsExternalSecretManager.applyForNamespace. App names are unique
            // within an application's topology but NOT across an org, so a bare
            // org-wide `appName IN (...)` match would pull a foreign app's secret
            // when two applications share an app name (e.g. "web").
            // Dependency apps ride the primary config.
            const secretRecords = await db.previewkitSecret.findMany({
                where: {
                    applicationId: application.id,
                    appName: { in: mergedConfig.apps.map((app) => app.name) },
                },
                select: { appName: true, awsSecretArn: true },
            });
            const arnByApp = new Map<string, string>();
            for (const s of secretRecords) arnByApp.set(s.appName, s.awsSecretArn);
            logger.info("Build step 6/7 building images for all apps", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                applicationId: application.id,
                apps: mergedConfig.apps.map((a) => a.name),
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
                isScoped ? appName : undefined,
            );
            const buildDurationMs = Date.now() - buildStart;

            const imageTags: Record<string, string> = {};
            for (const [name, outcome] of Object.entries(appBuilds)) {
                if (outcome.status === "success") imageTags[name] = outcome.imageTag;
            }
            const allBuildsFailed = Object.values(appBuilds).every((o) => o.status === "failed");
            logger.info("Build step 6/7 finished building images for all apps", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                durationMs: buildDurationMs,
                succeeded: Object.entries(appBuilds)
                    .filter(([, o]) => o.status === "success")
                    .map(([n]) => n),
                failed: Object.entries(appBuilds)
                    .filter(([, o]) => o.status === "failed")
                    .map(([n]) => n),
            });

            logger.info("Build step 7/7 recording build outcomes", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                allBuildsFailed,
            });
            // Skip the env-level build row when scoped: PreviewkitBuild is keyed
            // by (environment, headSha) and already exists for this env from the
            // full deploy - a scoped upsert would clobber its sibling app-build
            // rows. The per-app verdict is captured on the app's instance row below.
            if (!isScoped) {
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
            }

            // Transition each built app's lifecycle row to `built` (with its
            // imageTag) or `build_failed` (with the error) - the per-app build
            // verdict. Scoped to `buildApps` so a per-app rebuild does not map
            // every sibling (absent from `appBuilds`) to `build_failed`.
            await recordSafe(() =>
                recordAppStates(namespace, toBuildStates({ ...mergedConfig, apps: buildApps }, appBuilds)),
            );
            logger.info("Build step 7/7 recorded build outcomes", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
            });

            // A per-app rebuild never fails the whole environment: a failed target
            // build is recorded on its instance row and the deploy step records
            // its terminal state. Only a full deploy throws when every app failed.
            if (allBuildsFailed && !isScoped) {
                throw new Error("All app builds failed; see per-app build outcomes for details");
            }

            logger.info("Build phase complete", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                builtImages: Object.keys(imageTags),
            });

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
                addons: toAddonResults(mergedConfig, addonOutcomes),
                warnings,
                primaryAppNames: primaryConfig.apps.map((a) => a.name),
            };
        } finally {
            const dirsToClean = [primaryDir, ...dependencyEntries.map((e) => e.tmpDir)].filter((d) => d != null);
            logger.info("Build cleanup removing temp clone dirs", {
                repo: repoFullName,
                pr: prNumber,
                count: dirsToClean.length,
            });
            await Promise.all(
                dirsToClean.map((dir) =>
                    rm(dir, { recursive: true, force: true }).catch((err) =>
                        logger.warn("Failed to clean up temp dir", { dir, err }),
                    ),
                ),
            );
            logger.info("Build cleanup removed temp clone dirs", { repo: repoFullName, pr: prNumber });
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
        // Per-app redeploy (rebuild mode): deploy ONLY the target app and merge
        // its outcome into the environment, leaving siblings running untouched.
        if (input.appName != null && input.appName !== "") {
            return this.deployScopedApp(input, input.appName, signal);
        }
        const { event, commentId, imageTags, addonOutputs, buildOutcomes, addons, warnings, primaryAppNames } = input;
        const { repoFullName, prNumber, headSha, organizationId, githubRepositoryId } = event;
        // Re-hydrate the merged config across the Temporal activity boundary. The
        // config's resource policy was already applied upstream (the stored
        // config's overrides were honored), so this re-parse must preserve those values
        // rather than re-standardize them - hence the trusted schema, which passes
        // already-normalized resources through unchanged.
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

        logger.info("Deploying preview environment", {
            repo: repoFullName,
            pr: prNumber,
            apps: mergedConfig.apps.map((a) => a.name),
            services: mergedConfig.services.map((s) => s.name),
            builtImages: Object.keys(imageTags),
        });

        await this.statusWriter.checkpoint(signal, repoFullName, prNumber, "deploying-services");
        logger.info("Deploy step 1/7 deploying infra (namespace, services, gatekeeper handoff)", {
            repo: repoFullName,
            pr: prNumber,
        });
        const infraResult = await this.deployer.deployInfra(deployOpts);
        logger.info("Deploy step 1/7 deployed infra", {
            repo: repoFullName,
            pr: prNumber,
            namespace: infraResult.namespace,
        });

        // Database setup (schema, seed, migrations) runs now that the database
        // services are up and before the apps boot, so an app never starts
        // against an unmigrated database.
        await this.runDatabaseSetupTasks(
            mergedConfig,
            infraResult.namespace,
            repoFullName,
            prNumber,
            imageTags,
            addonOutputs,
        );

        await this.statusWriter.checkpoint(signal, repoFullName, prNumber, "pre-deploy-hooks");
        logger.info("Deploy step 2/7 running pre-deploy hooks", {
            repo: repoFullName,
            pr: prNumber,
            namespace: infraResult.namespace,
            hooks: mergedConfig.hooks.pre_deploy.length,
        });
        await this.runPreDeployHooks(
            mergedConfig,
            infraResult.namespace,
            repoFullName,
            prNumber,
            imageTags,
            addonOutputs,
        );
        logger.info("Deploy step 2/7 finished pre-deploy hooks", {
            repo: repoFullName,
            pr: prNumber,
            namespace: infraResult.namespace,
        });

        await this.statusWriter.checkpoint(signal, repoFullName, prNumber, "deploying-apps");
        // Mark the start of this deployment in the app-log stream so a fresh
        // app-log viewer replays only from here - a redeploy's runtime output
        // supersedes the prior deployment's logs retained in this namespace's
        // shared Loki stream. Emitted as the new app pods are about to roll out.
        // Best-effort; never blocks the deploy.
        void this.logSink?.markDeploymentStart(infraResult.namespace);
        // Mark the apps that built (have an image) as `deploying`. Apps whose
        // build failed have no imageTag and stay `build_failed`.
        const deployingStates: AppStateUpdate[] = mergedConfig.apps
            .filter((a) => imageTags[a.name] != null && imageTags[a.name] !== "")
            .map((a) => ({ appName: a.name, status: "deploying", port: a.port, imageTag: imageTags[a.name]! }));
        await recordSafe(() => recordAppStates(infraResult.namespace, deployingStates));
        logger.info("Deploy step 3/7 deploying apps wave-by-wave", {
            repo: repoFullName,
            pr: prNumber,
            namespace: infraResult.namespace,
            deployingApps: deployingStates.map((s) => s.appName),
        });
        const result = await this.deployer.deployApps(deployOpts, infraResult);
        logger.info("Deploy step 3/7 finished deploying apps", {
            repo: repoFullName,
            pr: prNumber,
            namespace: result.namespace,
            ready: Object.entries(result.appOutcomes)
                .filter(([, o]) => o.status === "ok")
                .map(([n]) => n),
            notReady: Object.entries(result.appOutcomes)
                .filter(([, o]) => o.status !== "ok")
                .map(([n]) => n),
        });

        const readyAppNamesForHooks = new Set(
            Object.entries(result.appOutcomes)
                .filter(([_, o]) => o.status === "ok")
                .map(([n]) => n),
        );

        await this.statusWriter.checkpoint(signal, repoFullName, prNumber, "post-deploy-hooks");
        logger.info("Deploy step 4/7 running post-deploy hooks", {
            repo: repoFullName,
            pr: prNumber,
            namespace: result.namespace,
            hooks: mergedConfig.hooks.post_deploy.length,
        });
        await this.runPostDeployHooks(
            mergedConfig,
            result,
            readyAppNamesForHooks,
            repoFullName,
            prNumber,
            imageTags,
            addonOutputs,
        );
        logger.info("Deploy step 4/7 finished post-deploy hooks", {
            repo: repoFullName,
            pr: prNumber,
            namespace: result.namespace,
        });

        signal?.throwIfAborted();
        const crashedApps = Object.entries(result.appOutcomes).flatMap(([name, o]) => {
            if (o.status === "failed" && o.crashLoopBackOff === true) {
                return [{ name, url: o.url }];
            }
            return [];
        });
        if (crashedApps.length > 0) {
            logger.info("Deploy step 5/7 restarting crash-looped apps after post_deploy hooks", {
                repo: repoFullName,
                pr: prNumber,
                namespace: result.namespace,
                apps: crashedApps.map((a) => a.name),
            });
            const recovered = await this.deployer.restartCrashedApps(result.namespace, crashedApps);
            for (const [name, outcome] of Object.entries(recovered)) {
                result.appOutcomes[name] = outcome;
            }
            logger.info("Deploy step 5/7 finished restarting crash-looped apps", {
                repo: repoFullName,
                pr: prNumber,
                namespace: result.namespace,
                recovered: Object.entries(recovered)
                    .filter(([, o]) => o.status === "ok")
                    .map(([n]) => n),
            });
        } else {
            logger.info("Deploy step 5/7 no crash-looped apps to restart", {
                repo: repoFullName,
                pr: prNumber,
                namespace: result.namespace,
            });
        }

        // Terminal, successor-owned writes below: bail explicitly before each.
        signal?.throwIfAborted();
        logger.info("Deploy step 6/7 computing final outcomes + recording per-app states", {
            repo: repoFullName,
            pr: prNumber,
            namespace: result.namespace,
        });
        const finalOutcomes = computeFinalOutcomes(mergedConfig, buildOutcomes, result.appOutcomes);
        const readyAppNames = new Set(finalOutcomes.filter((o) => o.status === "ok").map((o) => o.name));
        const readyCount = readyAppNames.size;
        const totalCount = finalOutcomes.length;

        // Persist the final per-app verdict for every app - ready, deploy_failed,
        // or skipped - before the all-failed guard below, so a built-but-undeployed
        // app is a distinct row even when no app came up at all.
        await recordSafe(() =>
            recordAppStates(
                result.namespace,
                toFinalAppStates(mergedConfig, buildOutcomes, result.appOutcomes, imageTags),
            ),
        );
        logger.info("Deploy step 6/7 recorded per-app states", {
            repo: repoFullName,
            pr: prNumber,
            namespace: result.namespace,
            readyCount,
            totalCount,
        });

        signal?.throwIfAborted();
        if (readyCount === 0) {
            throw new Error(`No apps deployed successfully (0/${totalCount}); see per-app outcomes for details`);
        }

        logger.info("Deploy step 7/7 marking environment ready", {
            repo: repoFullName,
            pr: prNumber,
            namespace: result.namespace,
            urls: result.urls,
        });
        await this.deployer.updateStatus(repoFullName, prNumber, {
            status: "ready",
            phase: "ready",
            urls: result.urls,
        });
        signal?.throwIfAborted();
        await recordSafe(() =>
            recordEnvironmentReady({
                namespace: result.namespace,
                urls: result.urls,
                bypassToken: result.bypassToken,
            }),
        );
        void this.logSink?.append(result.namespace, { kind: "status", message: "ready" });
        void this.logSink?.seal(result.namespace);
        logger.info("Deploy step 7/7 marked environment ready", {
            repo: repoFullName,
            pr: prNumber,
            namespace: result.namespace,
        });

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
     * Per-app redeploy (rebuild mode): deploy a SINGLE app into a live
     * environment and merge its outcome in, leaving siblings running untouched.
     * Infra is (re)applied with the FULL config so the namespace's Gatekeeper
     * routes annotation keeps every sibling's host and external secrets are
     * preserved (idempotent - unchanged resources are a no-op); only the target
     * app is (re)deployed, only its hooks run, and the
     * environment row's status/urls are MERGED (`recordAppRedeployOutcome`),
     * never overwritten. The caller skips `finalize`, so there is no PR-comment
     * or commit-status churn.
     */
    private async deployScopedApp(
        input: DeployPreviewEnvironmentInput,
        appName: string,
        signal?: AbortSignal,
    ): Promise<DeployPreviewEnvironmentOutput> {
        const { event, imageTags, addonOutputs, buildOutcomes, addons, warnings } = input;
        const { repoFullName, prNumber, headSha, organizationId, githubRepositoryId } = event;
        const mergedConfig = trustedPreviewConfigSchema.parse(JSON.parse(input.mergedConfigJson));

        const targetApp = mergedConfig.apps.find((a) => a.name === appName);
        if (targetApp == null) {
            throw new Error(`App "${appName}" not found in resolved config for ${input.namespace}`);
        }

        const targetImage = imageTags[appName];
        logger.info("Deploying single app into live environment", {
            repo: repoFullName,
            pr: prNumber,
            namespace: input.namespace,
            app: appName,
            hasImage: targetImage != null && targetImage !== "",
        });

        const deployOpts = {
            repoFullName,
            prNumber,
            headSha,
            organizationId,
            githubRepositoryId,
            config: mergedConfig,
            imageTags,
            addonOutputs,
            commentId: "",
        };

        signal?.throwIfAborted();
        const infraResult = await this.deployer.deployInfra(deployOpts);
        const namespace = infraResult.namespace;

        // Reuse the hook runners, but with the hook set filtered to the target -
        // a per-app redeploy must not re-run a sibling's migrations.
        const scopedHookConfig = {
            ...mergedConfig,
            hooks: {
                pre_deploy: mergedConfig.hooks.pre_deploy.filter((h) => h.app === appName),
                post_deploy: mergedConfig.hooks.post_deploy.filter((h) => h.app === appName),
            },
        };

        signal?.throwIfAborted();
        await this.runPreDeployHooks(scopedHookConfig, namespace, repoFullName, prNumber, imageTags, addonOutputs);

        // Mark the target `deploying` when it built; a build_failed target has no
        // image and keeps its build_failed row.
        if (targetImage != null && targetImage !== "") {
            await recordSafe(() =>
                recordAppStates(namespace, [
                    { appName, status: "deploying", port: targetApp.port, imageTag: targetImage },
                ]),
            );
        }

        signal?.throwIfAborted();
        const result = await this.deployer.deploySingleApp(deployOpts, infraResult, appName);

        const ready = result.appOutcomes[appName]?.status === "ok";
        await this.runPostDeployHooks(
            scopedHookConfig,
            result,
            new Set(ready ? [appName] : []),
            repoFullName,
            prNumber,
            imageTags,
            addonOutputs,
        );

        // Recover a crash-looped target after its post_deploy hooks (e.g. migrations).
        const outcome = result.appOutcomes[appName];
        if (outcome != null && outcome.status === "failed" && outcome.crashLoopBackOff === true) {
            const recovered = await this.deployer.restartCrashedApps(namespace, [{ name: appName, url: outcome.url }]);
            const r = recovered[appName];
            if (r != null) {
                result.appOutcomes[appName] = r;
                if (r.status !== "skipped") result.urls[appName] = r.url;
            }
        }

        // Persist the target's terminal state and merge it into the environment
        // (its url + recomputed env status) without disturbing siblings.
        signal?.throwIfAborted();
        const [targetState] = toFinalAppStates(
            { ...mergedConfig, apps: [targetApp] },
            buildOutcomes,
            result.appOutcomes,
            imageTags,
        );
        if (targetState != null) {
            await recordSafe(() => recordAppRedeployOutcome(namespace, targetState));
        }

        const finalOutcomes = computeFinalOutcomes(
            { ...mergedConfig, apps: [targetApp] },
            buildOutcomes,
            result.appOutcomes,
        );
        const services: PreviewServiceResult[] = finalOutcomes.map((o) => {
            const svc: PreviewServiceResult = { name: o.name, status: o.status === "ok" ? "ready" : "failed" };
            if (o.url != null) svc.url = o.url;
            if (o.error != null) svc.error = o.error;
            return svc;
        });
        const readyCount = finalOutcomes.filter((o) => o.status === "ok").length;

        // Mirror the full deploy's all-failed guard: a scoped redeploy that brought
        // up zero apps must FAIL the workflow (so it retries and alerts), not return
        // a "successful" output. The target's terminal state is already persisted
        // above, so the failure does not lose the per-app verdict.
        if (readyCount === 0) {
            throw new Error(
                `App "${appName}" redeploy failed (0/${finalOutcomes.length} ready); see per-app outcome for details`,
            );
        }

        const output: DeployPreviewEnvironmentOutput = {
            ready: readyCount === finalOutcomes.length,
            readyCount,
            totalCount: finalOutcomes.length,
            urls: result.urls,
            services,
            addons,
            warnings,
        };
        const previewUrl = finalOutcomes.find((o) => o.status === "ok")?.url;
        if (previewUrl != null) output.previewUrl = previewUrl;

        logger.info("Single app redeploy complete", {
            repo: repoFullName,
            pr: prNumber,
            namespace,
            app: appName,
            ready: readyCount > 0,
        });
        return output;
    }

    /**
     * Per-app redeploy (restart mode): re-roll a single app's pods (so it picks
     * up changed secrets/env without a rebuild), wait for readiness, then merge
     * the app's outcome into the environment. Reads the app's current instance
     * row to carry its port/imageTag/url through the wholesale-overwrite write.
     * Re-throws on failure (after recording `deploy_failed`) so the activity's
     * retry policy can ride out a transient k8s error.
     */
    async restartApp(event: PullRequestEvent, namespace: string, appName: string, signal?: AbortSignal): Promise<void> {
        const { repoFullName, prNumber } = event;
        logger.info("Restarting app", { repo: repoFullName, pr: prNumber, namespace, app: appName });

        signal?.throwIfAborted();
        const envRow = await db.previewkitEnvironment.findUnique({ where: { namespace }, select: { id: true } });
        if (envRow == null) {
            throw new Error(`Environment not found for namespace ${namespace}`);
        }
        const appRow = await db.previewkitAppInstance.findUnique({
            where: { environmentId_appName: { environmentId: envRow.id, appName } },
            select: { port: true, imageTag: true, url: true },
        });
        if (appRow == null) {
            throw new Error(`App "${appName}" not found in environment ${namespace}`);
        }

        const base: AppStateUpdate = {
            appName,
            port: appRow.port,
            status: "ready",
            imageTag: appRow.imageTag ?? undefined,
            url: appRow.url ?? undefined,
        };

        try {
            await this.deployer.restartApp(namespace, appName, signal);
            await recordSafe(() => recordAppRedeployOutcome(namespace, { ...base, status: "ready" }));
            logger.info("App restart succeeded", { repo: repoFullName, pr: prNumber, namespace, app: appName });
        } catch (err) {
            // A cancellation means a newer deploy/teardown has superseded this run
            // and now owns the env row (same namespace). Writing `deploy_failed`
            // here would clobber the successor's status, so on abort we only stop -
            // we never touch the DB. (Matches `markPreviewDeploySuperseded`.)
            if (signal?.aborted === true) {
                logger.info("App restart aborted by cancellation; leaving env row to successor", {
                    namespace,
                    app: appName,
                });
                throw err;
            }
            const error = err instanceof Error ? err.message : String(err);
            logger.error("App restart failed", err, { namespace, app: appName });
            await recordSafe(() => recordAppRedeployOutcome(namespace, { ...base, status: "deploy_failed", error }));
            throw err;
        }
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

        logger.info("Finalizing preview deploy", {
            repo: repoFullName,
            pr: prNumber,
            ready: result.ready,
            readyCount: result.readyCount,
            totalCount: result.totalCount,
            feedbackEnabled,
        });

        if (feedbackEnabled && commentId !== "") {
            logger.info("Finalize step 1/3 updating PR comment with result table", {
                repo: repoFullName,
                pr: prNumber,
                commentId,
            });
            await postOrUpdateCommentOnGithub({
                client: this.provider,
                store: createGitHubPrCommentStore(db, "preview"),
                repoFullName,
                prNumber,
                lastCommitSha: headSha,
                commentId,
                payload: await this.buildResultPayload(prNumber, headSha, result),
            });
            logger.info("Finalize step 1/3 updated PR comment", { repo: repoFullName, pr: prNumber });
        } else {
            logger.info("Finalize step 1/3 skipping PR comment update", {
                repo: repoFullName,
                pr: prNumber,
                feedbackEnabled,
                hasCommentId: commentId !== "",
            });
        }

        if (feedbackEnabled) {
            logger.info("Finalize step 2/3 setting final commit status", {
                repo: repoFullName,
                pr: prNumber,
                ready: result.ready,
            });
            await this.provider.setCommitStatus(
                repoFullName,
                headSha,
                result.ready ? "success" : "failure",
                result.ready ? "Preview environment ready" : `${result.readyCount}/${result.totalCount} apps ready`,
                result.previewUrl,
            );
            logger.info("Finalize step 2/3 set final commit status", { repo: repoFullName, pr: prNumber });
        } else {
            logger.info("Finalize step 2/3 skipping commit status (feedback disabled)", {
                repo: repoFullName,
                pr: prNumber,
            });
        }

        try {
            if (result.primaryUrl == null) {
                logger.warn("No primary URL resolved; deployment status will have no environment_url", {
                    repo: repoFullName,
                    pr: prNumber,
                });
            }
            logger.info("Finalize step 3/3 creating GitHub deployment + status (triggers diffs)", {
                repo: repoFullName,
                pr: prNumber,
            });
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
            logger.info("Finalize step 3/3 created GitHub deployment + status", {
                repo: repoFullName,
                pr: prNumber,
                deploymentId,
            });
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
        logger.error("Preview deployment failed", { repo: repoFullName, pr: prNumber, namespace, error });

        logger.info("Fail step 1/3 recording failed status", { repo: repoFullName, pr: prNumber, namespace });
        await this.deployer
            .updateStatus(repoFullName, prNumber, { status: "failed", phase: "failed", error })
            .catch((e) => logger.error("Failed to record failed status", e));

        await recordSafe(() => recordPhaseChanged({ namespace, status: "failed", phase: "failed", error }));
        void this.logSink?.append(namespace, { kind: "status", message: "failed" });
        void this.logSink?.seal(namespace);
        logger.info("Fail step 1/3 recorded failed status", { repo: repoFullName, pr: prNumber, namespace });

        if (feedbackEnabled && commentId !== "") {
            logger.info("Fail step 2/3 updating PR comment with failure", {
                repo: repoFullName,
                pr: prNumber,
                commentId,
            });
            await postOrUpdateCommentOnGithub({
                client: this.provider,
                store: createGitHubPrCommentStore(db, "preview"),
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
            logger.info("Fail step 2/3 updated PR comment with failure", { repo: repoFullName, pr: prNumber });
        } else {
            logger.info("Fail step 2/3 skipping failure PR comment", {
                repo: repoFullName,
                pr: prNumber,
                feedbackEnabled,
                hasCommentId: commentId !== "",
            });
        }

        if (feedbackEnabled) {
            logger.info("Fail step 3/3 setting failure commit status", { repo: repoFullName, pr: prNumber });
            await this.provider
                .setCommitStatus(repoFullName, headSha, "failure", "Preview deployment failed")
                .catch((e) => logger.error("Failed to set failure status", e));
            logger.info("Fail step 3/3 set failure commit status", { repo: repoFullName, pr: prNumber });
        } else {
            logger.info("Fail step 3/3 skipping failure commit status (feedback disabled)", {
                repo: repoFullName,
                pr: prNumber,
            });
        }

        logger.info("Preview deployment failure finalizer complete", { repo: repoFullName, pr: prNumber, namespace });
    }

    // Resolves the target branch, resolves the dependency's config (owned by
    // the primary config's dependencyDocuments, passed in), and clones the repo
    // into a temp dir. Returns null when the dependency has no config (opt-out).
    private async cloneDependency(
        dep: RepoDependency,
        prNumber: number,
        headRef: string,
        convention: BranchConvention | undefined,
        dependencyConfig: PreviewConfig | undefined,
    ): Promise<DependencyEntry | null> {
        const targetBranch = resolveTargetBranch(headRef, convention, dep.fallback_branch);

        const resolved = await resolveDependencyConfig(this.provider, dep, targetBranch, dependencyConfig);
        if (resolved == null) return null;

        const tmpDir = await mkdtemp(path.join(os.tmpdir(), `previewkit-${prNumber}-${dep.name}-`));
        // Fetch at the resolved SHA, not the branch name: this pins the deployed
        // code to the exact commit recorded as provenance, even if the branch
        // moves between branch-head resolution and this fetch.
        await this.provider.fetchRepoTarball(dep.repo, resolved.sha, tmpDir);
        logger.info("Cloned dependency repo", {
            name: dep.name,
            repo: dep.repo,
            branch: resolved.branch,
            sha: resolved.sha,
            usedFallback: resolved.usedFallback,
        });
        return {
            dep,
            config: resolved.config,
            tmpDir,
            usedFallback: resolved.usedFallback,
            targetBranch,
            sha: resolved.sha,
        };
    }

    private mergeConfigs(primaryConfig: PreviewConfig, deps: DependencyEntry[]): PreviewConfig {
        const shaByDepName = new Map(deps.map((d) => [d.dep.name, d.sha]));
        return {
            ...primaryConfig,
            config: enrichDependencyShas(primaryConfig.config, shaByDepName),
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
        onlyAppName?: string,
    ): Promise<Record<string, AppBuildOutcome>> {
        const [rawOrg, rawRepo] = repoFullName.split("/");
        const org = rawOrg!.toLowerCase();
        const repo = rawRepo!.toLowerCase();

        // Templating context for build_args. Resolves `{{name.host}}`,
        // `{{name.port}}`, `{{name.url}}`, `{{pr}}`, `{{namespace}}`, `{{owner}}`,
        // and now `{{addonName.<key>}}` for successfully provisioned addons -
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

        // Each app is built independently - a failure in one app is captured
        // into its own outcome and does not abort the other builds. `buildOneApp`
        // only throws for a supersede abort (BuildAbortedError), in which case we
        // want the whole build to reject and bail; every other error becomes a
        // failed app outcome. Builds run in parallel with one buildkitd Job per
        // app. On abort, wait for every sibling to settle so each Job's cleanup
        // finishes before the runner exits.
        // `onlyAppName` (per-app redeploy) narrows which apps build, while the
        // full `config` is kept so build-arg templates can still reference siblings.
        const appsToBuild = onlyAppName != null ? config.apps.filter((a) => a.name === onlyAppName) : config.apps;
        const results = await Promise.allSettled(
            appsToBuild.map(async (app) => {
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
        const rejection = results.find((result) => result.status === "rejected");
        if (rejection != null && rejection.status === "rejected") {
            throw rejection.reason;
        }
        const entries = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

        return Object.fromEntries(entries);
    }

    /**
     * Resolves an app's build inputs. An explicit `build` block is the single
     * source of strategy: a `dockerfile` framework builds the named Dockerfile;
     * any other framework builds a generated Dockerfile (via `generateDockerfile`);
     * `build_context: root` builds from the repo root. With no `build` block, falls
     * back to the legacy dockerfile / monorepo / Railpack path (removed once `build`
     * is universal).
     */
    private resolveBuildInputs(
        app: PreviewConfig["apps"][number],
        repoDir: string,
        resolvedBuildArgs: Record<string, string>,
    ): {
        contextPath: string;
        buildContext?: string;
        dockerfile?: string;
        target?: string;
        generatedDockerfile?: string;
        monorepoTool?: "turbo";
    } {
        const appDir = path.resolve(repoDir, app.path);

        if (app.build != null) {
            const build = app.build;
            const contextPath = build.build_context === "root" ? repoDir : appDir;
            if (build.framework === "dockerfile") {
                return { contextPath, dockerfile: build.dockerfile, target: build.target };
            }
            const generatedDockerfile = generateDockerfile(build, {
                registryMirror: this.dockerHubMirror,
                buildArgs: resolvedBuildArgs,
                port: app.port,
                appName: app.name,
                turboFilter: resolveBuildTurboFilter(build, repoDir, app.path),
            });
            return { contextPath, generatedDockerfile };
        }

        const buildContext =
            app.build_context != null
                ? path.resolve(repoDir, app.build_context)
                : app.monorepo != null
                  ? repoDir
                  : undefined;
        return {
            contextPath: appDir,
            ...(buildContext != null ? { buildContext } : {}),
            ...(app.dockerfile != null ? { dockerfile: app.dockerfile } : {}),
            ...(app.monorepo != null ? { monorepoTool: app.monorepo } : {}),
        };
    }

    /**
     * Builds one app's image. Catches all failures and returns a structured
     * outcome instead of throwing - the caller relies on this to keep the other
     * apps' builds running when one fails.
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
            const appArn = ctx.arnByApp.get(app.name);
            const secretBuildArgs =
                app.build_secrets.length > 0 && appArn != null
                    ? this.awsSecretsFetcher.pickKeys(
                          await this.awsSecretsFetcher.fetchJson(appArn),
                          app.build_secrets,
                          appArn,
                      )
                    : {};

            // Build-time connections are topology values (e.g. a Vite frontend's
            // {{api.url}}) baked into the image; they resolve like runtime
            // connections but are passed as build args. Secret build args win on
            // a key collision (explicit secret over a wired value).
            const buildTimeConnections: Record<string, string> = {};
            for (const connection of app.connections) {
                if (connection.build_time) {
                    buildTimeConnections[connection.key] = connection.value;
                }
            }
            const mergedBuildArgs: Record<string, string> = { ...buildTimeConnections, ...secretBuildArgs };

            const resolvedBuildArgs = ctx.envInjector.applyTemplates(
                mergedBuildArgs,
                ctx.config.apps,
                ctx.config.services,
                ctx.namespace,
                ctx.templateContext,
                ctx.publicUrlInfo,
                ctx.addonOutputs,
            );

            const buildInputs = this.resolveBuildInputs(app, dir, resolvedBuildArgs);
            const result = await this.builder.build({
                appName: app.name,
                contextPath: buildInputs.contextPath,
                buildArgs: resolvedBuildArgs,
                imageTag,
                namespace: ctx.namespace,
                buildContext: buildInputs.buildContext,
                dockerfile: buildInputs.dockerfile,
                target: buildInputs.target,
                generatedDockerfile: buildInputs.generatedDockerfile,
                monorepoTool: buildInputs.monorepoTool,
                signal: ctx.signal,
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
            // Log the technical error (Sentry/structured logs), but record the
            // safe user-facing reason when the builder supplied one (a platform
            // outage is not the user's fault); fall back to the raw message.
            const message = err instanceof Error ? err.message : String(err);
            logger.error("App build failed", err, { app: app.name });
            const recordedError =
                err instanceof BuildError && err.userFacingMessage != null ? err.userFacingMessage : message;
            return { status: "failed", durationMs: Date.now() - start, error: recordedError };
        }
    }

    /**
     * Relay one line of pre/post-deploy hook output to the customer-facing
     * build-log stream, scoped to the hook's app so it surfaces in that app's
     * logs. Deliberately bypasses the Sentry/console logger: hook output may
     * echo secrets, which must never reach the telemetry plane (see
     * BuildLogEvent). Fire-and-forget, mirroring the sink's other call sites.
     */
    private appendHookLog(namespace: string, app: string, message: string, stream?: "stdout" | "stderr"): void {
        void this.logSink?.append(namespace, { kind: "log", app, stream, message });
    }

    /**
     * Runs one pre/post-deploy hook as a one-off Kubernetes Job built from the
     * hook app's image, resolving the app's env and relaying the Job's output
     * to the build-log viewer. Both hook phases run this way - there is no
     * in-pod exec path. Throws on failure; the caller decides whether that is
     * fatal (pre-deploy aborts the deploy, post-deploy logs and continues).
     */
    private async runHookJobStep(
        hook: PreviewConfig["hooks"]["pre_deploy"][number],
        config: PreviewConfig,
        namespace: string,
        repoFullName: string,
        prNumber: number,
        imageTags: Record<string, string>,
        addonOutputs: AddonOutputs,
    ): Promise<void> {
        const imageTag = imageTags[hook.app];
        if (imageTag == null) {
            throw new Error(
                `Deploy hook for app "${hook.app}" has no built image - ` +
                    `did the build fail? Available: ${Object.keys(imageTags).join(", ")}`,
            );
        }
        const appConfig = config.apps.find((a) => a.name === hook.app);
        if (appConfig == null) {
            throw new Error(`Deploy hook references unknown app "${hook.app}"`);
        }
        const org = repoFullName.split("/")[0]!.toLowerCase();
        const context = { pr: String(prNumber), namespace, owner: org };
        const publicUrlInfo: PublicUrlInfo = {
            domain: config.domain ?? this.deployer.getDomain(),
            repoFullName,
            secret: this.deployer.getSecret(),
            prNumber,
        };
        const resolvedEnv = this.deployer
            .getEnvInjector()
            .resolveConnections(
                appConfig.connections,
                config.apps,
                config.services,
                namespace,
                context,
                publicUrlInfo,
                addonOutputs,
            );
        this.appendHookLog(namespace, hook.app, `$ ${hook.command}`);
        const kc = this.deployer.getKubeConfig();
        await runHookJob(kc, namespace, hook.app, imageTag, hook.command, resolvedEnv, {
            onLog: (line) => this.appendHookLog(namespace, hook.app, line),
        });
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

        for (const hook of config.hooks.pre_deploy) {
            logger.info("Executing pre-deploy hook Job", { namespace, app: hook.app, command: hook.command });
            await this.runHookJobStep(hook, config, namespace, repoFullName, prNumber, imageTags, addonOutputs);
            logger.info("Finished pre-deploy hook Job", { namespace, app: hook.app, command: hook.command });
        }
        logger.info("Finished running pre-deploy hooks", { namespace, hooks: config.hooks.pre_deploy.length });
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

        for (const hook of runnable) {
            logger.info("Executing post-deploy hook Job", { app: hook.app, command: hook.command });
            try {
                await this.runHookJobStep(
                    hook,
                    config,
                    result.namespace,
                    repoFullName,
                    prNumber,
                    imageTags,
                    addonOutputs,
                );
                logger.info("Finished post-deploy hook Job", {
                    namespace: result.namespace,
                    app: hook.app,
                    command: hook.command,
                });
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
        logger.info("Finished running post-deploy hooks", { namespace: result.namespace, hooks: runnable.length });
    }

    /**
     * Runs each service's database setup tasks (schema, seed, migrations) after
     * the database services are up and before the apps deploy. Tasks run as
     * one-off Jobs with the repo checked out - the same Job runner as deploy
     * hooks, from a built app image that carries the repo. `on_create` tasks run
     * once per database lifetime (gated by a namespace marker ConfigMap);
     * `every_commit` tasks run on every deploy. A failing task aborts the deploy,
     * like a pre-deploy hook, so an app never boots against a half-set-up database.
     */
    private async runDatabaseSetupTasks(
        config: PreviewConfig,
        namespace: string,
        repoFullName: string,
        prNumber: number,
        imageTags: Record<string, string>,
        addonOutputs: AddonOutputs,
    ): Promise<void> {
        const servicesWithTasks = config.services.filter((s) => s.setup_tasks.length > 0);
        if (servicesWithTasks.length === 0) return;

        for (const service of servicesWithTasks) {
            const setupHasRun = await this.deployer.databaseSetupHasRun(namespace, service.name);
            const tasks = setupHasRun
                ? service.setup_tasks.filter((task) => task.frequency === "every_commit")
                : service.setup_tasks;
            const hasOnCreateTasks = service.setup_tasks.some((task) => task.frequency === "on_create");
            logger.info("Running database setup tasks", {
                namespace,
                service: service.name,
                tasks: tasks.length,
                onCreateAlreadyRan: setupHasRun,
            });
            for (const task of tasks) {
                await this.runSetupTaskStep(
                    task,
                    service.name,
                    config,
                    namespace,
                    repoFullName,
                    prNumber,
                    imageTags,
                    addonOutputs,
                );
            }
            // Mark the database's one-time setup done once its on_create tasks have
            // succeeded (they throw on failure above, so a failed run re-runs next
            // deploy). The marker is per-database, not per-task: it gates EVERY
            // on_create task for the database's lifetime (the PVC persists across a
            // PR's redeploys), so editing or adding an on_create task after this
            // point does not re-run it - the database already counts as created.
            // every_commit tasks are unaffected and run on every deploy.
            if (!setupHasRun && hasOnCreateTasks) {
                await this.deployer.markDatabaseSetupComplete(namespace, service.name);
            }
        }
    }

    private async runSetupTaskStep(
        task: PreviewConfig["services"][number]["setup_tasks"][number],
        serviceName: string,
        config: PreviewConfig,
        namespace: string,
        repoFullName: string,
        prNumber: number,
        imageTags: Record<string, string>,
        addonOutputs: AddonOutputs,
    ): Promise<void> {
        const appName = resolveSetupTaskApp(task, config);
        if (appName == null) {
            throw new Error(`Database setup task for "${serviceName}" has no app to run in`);
        }
        const imageTag = imageTags[appName];
        if (imageTag == null) {
            throw new Error(
                `Database setup task for "${serviceName}" runs in app "${appName}" which has no built image - did the build fail?`,
            );
        }
        const appConfig = config.apps.find((a) => a.name === appName);
        if (appConfig == null) {
            throw new Error(`Database setup task references unknown app "${appName}"`);
        }
        const org = repoFullName.split("/")[0]!.toLowerCase();
        const context = { pr: String(prNumber), namespace, owner: org };
        const publicUrlInfo: PublicUrlInfo = {
            domain: config.domain ?? this.deployer.getDomain(),
            repoFullName,
            secret: this.deployer.getSecret(),
            prNumber,
        };
        const resolvedEnv = this.deployer
            .getEnvInjector()
            .resolveConnections(
                appConfig.connections,
                config.apps,
                config.services,
                namespace,
                context,
                publicUrlInfo,
                addonOutputs,
            );
        this.appendHookLog(namespace, appName, `$ [db-setup ${serviceName}] ${task.command}`);
        const kc = this.deployer.getKubeConfig();
        await runHookJob(kc, namespace, appName, imageTag, task.command, resolvedEnv, {
            onLog: (line) => this.appendHookLog(namespace, appName, line),
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

/**
 * Picks the built app image a database setup task runs in - it carries the
 * repo checkout the task's command needs. An `in_build` task names its app
 * directly; a `separate_job` task runs in the primary app's image (the primary
 * repo's checkout). Returns undefined only when the config has no apps.
 */
function resolveSetupTaskApp(
    task: PreviewConfig["services"][number]["setup_tasks"][number],
    config: PreviewConfig,
): string | undefined {
    if (task.location.type === "in_build") return task.location.app;
    const primary = config.apps.find((app) => app.primary === true) ?? config.apps[0];
    return primary?.name;
}
