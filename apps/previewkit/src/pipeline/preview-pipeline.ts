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
import { buildPreviewFrontDoorUrl } from "@autonoma/types";
import type {
    BuildPreviewImagesOutput,
    DeployPreviewEnvironmentInput,
    DeployPreviewEnvironmentOutput,
    PreviewServiceResult,
} from "@autonoma/types";
import { BuildAbortedError, BuildError, type Builder } from "../builder/builder";
import { buildPreviewCacheReference, buildPreviewImageReference } from "../builder/image-reference";
import { loadConfig } from "../config/load-config";
import {
    type AppConfig,
    blueprintToBuild,
    isSameRepository,
    type PreviewConfig,
    trustedPreviewConfigSchema,
} from "../config/schema";
import {
    type AppBuildOutcome,
    type AppStateUpdate,
    failInFlightApps,
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
import { type EnvInjector, type PublicUrlInfo } from "../deployer/env-injector";
import { runHookJob } from "../deployer/hook-job-runner";
import { resolvePrimaryUrl } from "../diffs/resolve-primary-url";
import { resolveSdkAppUrl } from "../diffs/resolve-sdk-app-url";
import { detectBlueprintFacts } from "../dockerfile-builder/detect-blueprint-facts";
import { generateDockerfile } from "../dockerfile-builder/generate-dockerfile";
import { resolveBuildTurboFilter } from "../dockerfile-builder/resolve-build-turbo-filter";
import { env } from "../env";
import type { PullRequestEvent } from "../git-provider/git-provider";
import type { GitProvider } from "../git-provider/git-provider";
import { logger } from "../logger";
import { enrichRepositoryShas } from "../multirepo/enrich-repository-shas";
import { resolveDependencyCheckout } from "../multirepo/resolve-dependency-checkout";
import { resolveTargetBranch } from "../multirepo/resolve-target-branch";
import type { BuildSecretSource } from "../secrets/build-secret-source";
import { computeFinalOutcomes, toBuildStates, toFinalAppStates } from "./outcomes";
import { StatusWriter } from "./status-writer";

// A failed hook's error carries the Job's whole log, while a PR-comment warning
// renders as a single blockquote bullet - these bound what a post-deploy hook
// failure contributes to that callout (see summarizeHookFailure).
const HOOK_WARNING_TAIL_LINES = 3;
const HOOK_WARNING_MAX_CHARS = 300;

/**
 * Shared input to every per-app build. Computed once at the top of
 * `buildAllApps` and passed unchanged into each `buildOneApp` invocation -
 * the per-app value (`app`) is the only parameter that varies across builds.
 */
interface AppBuildContext {
    config: PreviewConfig;
    appRepoDirs: Map<string, string>;
    secretApps: Set<string>;
    applicationId: string;
    envInjector: EnvInjector;
    namespace: string;
    templateContext: { pr: string; namespace: string; owner: string };
    publicUrlInfo: PublicUrlInfo;
    registry: string;
    org: string;
    repo: string;
    prNumber: number;
    shortSha: string;
    // Aborts the in-flight buildctl when the deploy is superseded/cancelled.
    signal?: AbortSignal;
}

/**
 * How one multirepo dependency repo will be checked out: the branch the
 * convention resolved to and the repo's configured fallback. Derived per
 * distinct non-primary `apps[].repository` value before any cloning starts.
 */
interface DependencyClonePlan {
    /** Repo full name (`owner/repo`), as written on the apps. */
    repo: string;
    targetBranch: string;
    fallbackBranch: string;
}

interface DependencyEntry {
    plan: DependencyClonePlan;
    tmpDir: string;
    usedFallback: boolean;
    /** The concrete commit SHA this dependency was deployed at. */
    sha: string;
}

interface PreviewPipelineOptions {
    provider: GitProvider;
    builder: Builder;
    deployer: Deployer;
    buildSecrets: BuildSecretSource;
    registryUrl: string;
    /** ECR pull-through cache prefix for Docker Hub; threaded into generated
     *  Dockerfile base images. "" disables mirroring (see mirrorDockerHubImage). */
    dockerHubMirror: string;
    /** npm/bun package-registry cache URL, threaded into generated Dockerfiles
     *  as ENV lines (see GenerateDockerfileContext.npmRegistryMirror). ""
     *  disables injection. */
    npmRegistryMirror: string;
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
    private readonly buildSecrets: BuildSecretSource;
    private readonly registryUrl: string;
    private readonly dockerHubMirror: string;
    private readonly npmRegistryMirror: string;
    private readonly logSink?: BuildLogSink;
    private readonly statusWriter: StatusWriter;

    constructor(options: PreviewPipelineOptions) {
        this.provider = options.provider;
        this.builder = options.builder;
        this.deployer = options.deployer;
        this.buildSecrets = options.buildSecrets;
        this.registryUrl = options.registryUrl;
        this.dockerHubMirror = options.dockerHubMirror;
        this.npmRegistryMirror = options.npmRegistryMirror;
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
                    kind: "preview",
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
     * snapshot the resolved config, and build every app image to ECR. Temp dirs
     * are cloned and torn down entirely within this step. Previews are
     * all-or-nothing, so a full deploy throws when any app is skipped (its
     * repository has no resolvable branch) or any build fails.
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

        logger.info("Build step 1/6 resolving linked Application", {
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
        logger.info("Build step 1/6 resolved linked Application", {
            repo: repoFullName,
            pr: prNumber,
            applicationId: application.id,
        });

        logger.info("Build step 2/6 resolving preview config", {
            repo: repoFullName,
            pr: prNumber,
            applicationId: application.id,
        });
        const storedConfig = await loadConfig(application.id);
        if (storedConfig == null) {
            throw new Error(`No preview config for ${repoFullName} at ${shortSha}`);
        }
        logger.info("Build step 2/6 resolved preview config", {
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
            const clonePlans = this.planDependencyClones(storedConfig, repoFullName, event.headRef);
            logger.info("Build step 3/6 cloning primary + dependency repos", {
                repo: repoFullName,
                pr: prNumber,
                sha: shortSha,
                dependencyCount: clonePlans.length,
            });
            primaryDir = await mkdtemp(path.join(os.tmpdir(), `previewkit-${prNumber}-`));
            const [dependencyResults] = await Promise.all([
                Promise.all(clonePlans.map((plan) => this.cloneDependency(plan, prNumber))),
                this.provider.fetchRepoTarball(repoFullName, headSha, primaryDir),
            ]);
            dependencyEntries = dependencyResults.filter((e): e is DependencyEntry => e != null);
            const clonedRepos = new Set(dependencyEntries.map((entry) => entry.plan.repo.toLowerCase()));
            const skippedPlans = clonePlans.filter((plan) => !clonedRepos.has(plan.repo.toLowerCase()));
            logger.info("Build step 3/6 cloned primary + dependency repos", {
                repo: repoFullName,
                pr: prNumber,
                clonedDependencies: dependencyEntries.length,
                skippedDependencies: skippedPlans.length,
            });

            logger.info("Build step 4/6 enriching config + snapshotting + seeding app rows", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
            });
            // The full topology with per-dependency deploy provenance stamped
            // onto `repositories[]`. This stays CANONICAL end-to-end - skipped
            // apps included - so Gatekeeper routes and the deploy-wave graph
            // always see every app (a filtered config would drop a running
            // sibling's route on a scoped rebuild, and a surviving app's
            // depends_on edge to a skipped app would read as a dangling edge).
            const mergedConfig = enrichRepositoryShas(
                storedConfig,
                new Map(dependencyEntries.map((entry) => [entry.plan.repo, entry.sha])),
            );
            // Apps whose repository has no resolvable branch cannot build or
            // deploy this round: they are recorded `skipped` with the reason.
            // A full deploy then fails fast below - a preview is all-or-nothing,
            // and an app that can never come up makes it unpublishable - while a
            // scoped rebuild fails only when the target itself is skipped.
            const skippedRepos = new Set(skippedPlans.map((plan) => plan.repo.toLowerCase()));
            const skipReasonByRepo = new Map(
                skippedPlans.map((plan) => [
                    plan.repo.toLowerCase(),
                    `Repository ${plan.repo} has neither branch "${plan.targetBranch}" nor fallback branch ` +
                        `"${plan.fallbackBranch}" - apps from it were skipped`,
                ]),
            );
            const skippedApps = mergedConfig.apps.filter((app) => skippedRepos.has(app.repository.toLowerCase()));
            const skippedAppReasons: Record<string, string> = {};
            for (const app of skippedApps) {
                skippedAppReasons[app.name] =
                    skipReasonByRepo.get(app.repository.toLowerCase()) ?? "Repository branch could not be resolved";
            }
            if (isScoped) {
                const skipReason = skippedAppReasons[appName];
                if (skipReason != null) throw new Error(skipReason);
                if (!mergedConfig.apps.some((a) => a.name === appName)) {
                    throw new Error(`App "${appName}" not found in resolved config for ${repoFullName} PR ${prNumber}`);
                }
            }
            // The apps to build: just the target when scoped, otherwise every
            // non-skipped app.
            const buildApps = isScoped
                ? mergedConfig.apps.filter((a) => a.name === appName)
                : mergedConfig.apps.filter((a) => skippedAppReasons[a.name] == null);
            // Snapshot the effective config - the full topology, skipped apps
            // included (their rows say why). The summary + readiness views
            // project it for display and failure diagnostics. Overwritten on
            // each deploy once resolved.
            await recordSafe(() => recordResolvedConfig({ namespace, resolvedConfig: mergedConfig }));

            // Moment 0: now that the config names every app, seed a `pending`
            // lifecycle row per app so each has a distinct status record from
            // the start (and stale rows from a prior commit are pruned/reset).
            // Skipped when scoped - `recordAppsPending` prunes rows for apps not
            // in the list, which would wipe every sibling; a per-app rebuild
            // touches only the target's row (below).
            if (!isScoped) {
                await recordSafe(() =>
                    recordAppsPending(
                        namespace,
                        mergedConfig.apps.map((a) => ({ appName: a.name, port: a.port })),
                    ),
                );
                if (skippedApps.length > 0) {
                    await recordSafe(() =>
                        recordAppStates(
                            namespace,
                            skippedApps.map((a) => ({
                                appName: a.name,
                                status: "skipped",
                                port: a.port,
                                error: skippedAppReasons[a.name],
                            })),
                        ),
                    );
                    // No partial previews: an app that can never come up makes the
                    // preview unpublishable, so fail now - before any image builds
                    // or infra spend. The rows above keep each reason queryable.
                    const reasons = skippedApps
                        .map((a) => skippedAppReasons[a.name])
                        .filter((reason) => reason != null)
                        .join("; ");
                    throw new Error(`Preview cannot be complete: ${reasons}`);
                }
            }
            logger.info("Build step 4/6 enriched config + snapshotted + seeded app rows", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                apps: mergedConfig.apps.map((a) => a.name),
                skippedApps: skippedApps.map((a) => a.name),
                services: mergedConfig.services.map((s) => s.name),
            });

            const dirByRepo = new Map<string, string>();
            dirByRepo.set(repoFullName.toLowerCase(), primaryDir);
            for (const entry of dependencyEntries) {
                dirByRepo.set(entry.plan.repo.toLowerCase(), entry.tmpDir);
            }
            const appRepoDirs = new Map<string, string>();
            for (const app of mergedConfig.apps) {
                const dir = dirByRepo.get(app.repository.toLowerCase());
                if (dir != null) appRepoDirs.set(app.name, dir);
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
            // RuntimeSecrets.applyForNamespace. App names are unique
            // within an application's topology but NOT across an org, so a bare
            // org-wide `appName IN (...)` match would pull a foreign app's secret
            // when two applications share an app name (e.g. "web").
            // Dependency apps ride the primary config.
            const secretRecords = await db.previewkitSecret.findMany({
                where: {
                    applicationId: application.id,
                    appName: { in: mergedConfig.apps.map((app) => app.name) },
                },
                select: { appName: true },
                distinct: ["appName"],
            });
            // Which of this deploy's apps hold at least one secret. Only presence
            // matters here: the values are read from the bundle when they are needed.
            const secretApps = new Set(secretRecords.map((record) => record.appName));
            logger.info("Build step 5/6 building images for all apps", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                applicationId: application.id,
                apps: mergedConfig.apps.map((a) => a.name),
                registeredSecretApps: [...secretApps].sort(),
            });
            const appBuilds = await this.buildAllApps(
                mergedConfig,
                buildApps,
                appRepoDirs,
                repoFullName,
                prNumber,
                shortSha,
                secretApps,
                application.id,
                signal,
            );
            const buildDurationMs = Date.now() - buildStart;

            const imageTags: Record<string, string> = {};
            for (const [name, outcome] of Object.entries(appBuilds)) {
                if (outcome.status === "success") imageTags[name] = outcome.imageTag;
            }
            const failedBuildApps = Object.entries(appBuilds)
                .filter(([, outcome]) => outcome.status === "failed")
                .map(([name]) => name);
            const anyBuildFailed = failedBuildApps.length > 0;
            logger.info("Build step 5/6 finished building images for all apps", {
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

            logger.info("Build step 6/6 recording build outcomes", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                failedBuildApps,
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
                        status: anyBuildFailed ? "failed" : "building",
                        durationMs: buildDurationMs,
                        appBuilds,
                        error: anyBuildFailed ? `App builds failed: ${failedBuildApps.join(", ")}` : undefined,
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
            logger.info("Build step 6/6 recorded build outcomes", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
            });

            // No partial previews: one failed build fails the whole deploy (the
            // per-app rows above carry each verdict, so nothing is lost). A
            // per-app rebuild still never fails the environment - its target's
            // failure is recorded on the instance row instead.
            if (anyBuildFailed && !isScoped) {
                throw new Error(
                    `App builds failed: ${failedBuildApps.join(", ")}; ` +
                        "a preview deploys only when every app builds - see per-app build outcomes for details",
                );
            }

            logger.info("Build phase complete", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                builtImages: Object.keys(imageTags),
            });

            const warnings = [
                ...dependencyEntries
                    .filter((e) => e.usedFallback)
                    .map(
                        (entry) =>
                            `${entry.plan.repo} branch ${entry.plan.targetBranch} not found; ` +
                            `used ${entry.plan.fallbackBranch} instead.`,
                    ),
                ...skippedPlans.map(
                    (plan) =>
                        `${plan.repo} has neither branch ${plan.targetBranch} nor fallback ` +
                        `${plan.fallbackBranch}; its apps were skipped.`,
                ),
            ];

            return {
                mergedConfigJson: JSON.stringify(mergedConfig),
                imageTags,
                buildOutcomes: appBuilds,
                warnings,
                skippedApps: skippedAppReasons,
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
     * flat, comment-ready result rows. Previews are all-or-nothing: throws unless
     * every app comes up, so a returned result is always fully ready.
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
        const { event, commentId, imageTags, buildOutcomes, warnings } = input;
        const skippedApps = input.skippedApps ?? {};
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
        await this.runDatabaseSetupTasks(mergedConfig, infraResult.namespace, repoFullName, prNumber, imageTags);

        await this.statusWriter.checkpoint(signal, repoFullName, prNumber, "pre-deploy-hooks");
        logger.info("Deploy step 2/7 running pre-deploy hooks", {
            repo: repoFullName,
            pr: prNumber,
            namespace: infraResult.namespace,
            hooks: mergedConfig.hooks.pre_deploy.length,
        });
        // A hook targeting a skipped app has no image to run from, so it is
        // skipped with its app rather than aborting the deploy - the app's
        // skipped row already names the reason.
        const skippedHooks = mergedConfig.hooks.pre_deploy.filter((hook) => skippedApps[hook.app] != null);
        if (skippedHooks.length > 0) {
            logger.info("Skipping pre-deploy hooks targeting skipped apps", {
                repo: repoFullName,
                pr: prNumber,
                namespace: infraResult.namespace,
                extra: { hooks: skippedHooks.map((hook) => hook.app) },
            });
        }
        const runnableHooksConfig: PreviewConfig = {
            ...mergedConfig,
            hooks: {
                ...mergedConfig.hooks,
                pre_deploy: mergedConfig.hooks.pre_deploy.filter((hook) => skippedApps[hook.app] == null),
            },
        };
        await this.runPreDeployHooks(runnableHooksConfig, infraResult.namespace, repoFullName, prNumber, imageTags);
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
        const hookWarnings = await this.runPostDeployHooks(
            mergedConfig,
            result,
            readyAppNamesForHooks,
            repoFullName,
            prNumber,
            imageTags,
        );
        logger.info("Deploy step 4/7 finished post-deploy hooks", {
            repo: repoFullName,
            pr: prNumber,
            namespace: result.namespace,
            failedHooks: hookWarnings.length,
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
        const finalOutcomes = computeFinalOutcomes(mergedConfig, buildOutcomes, result.appOutcomes, skippedApps);
        const readyAppNames = new Set(finalOutcomes.filter((o) => o.status === "ok").map((o) => o.name));
        const readyCount = readyAppNames.size;
        const totalCount = finalOutcomes.length;

        // Persist the final per-app verdict for every app - ready, deploy_failed,
        // or skipped - before the all-failed guard below, so a built-but-undeployed
        // app is a distinct row even when no app came up at all.
        await recordSafe(() =>
            recordAppStates(
                result.namespace,
                toFinalAppStates(mergedConfig, buildOutcomes, result.appOutcomes, imageTags, skippedApps),
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
        // No partial previews: every app must be ready or the deploy fails as a
        // whole - the failure finalizer then marks the environment failed and
        // scales its workloads to zero. The per-app terminal states are already
        // persisted above, so each app's own verdict survives the throw.
        if (readyCount < totalCount) {
            const notReadyApps = finalOutcomes.filter((o) => o.status !== "ok").map((o) => o.name);
            throw new Error(
                `Preview environment incomplete: ${readyCount}/${totalCount} apps ready (not ready: ` +
                    `${notReadyApps.join(", ")}); a preview is only published when every app is ready - ` +
                    "see per-app outcomes for details",
            );
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

        const primaryApps = mergedConfig.apps.filter((a) => isSameRepository(a.repository, repoFullName));
        const previewUrl = finalOutcomes.find((o) => o.status === "ok")?.url;
        const primaryUrl = resolvePrimaryUrl(primaryApps, result.urls);
        // Scoped to the whole topology, unlike the primary URL: the app serving the
        // Environment Factory handler can be a connected repo's API, and its
        // declaration only reaches the merged config.
        const sdkAppUrl = resolveSdkAppUrl({ all: mergedConfig.apps, primaryRepo: primaryApps }, result.urls);

        const output: DeployPreviewEnvironmentOutput = {
            ready: readyCount === totalCount,
            readyCount,
            totalCount,
            urls: result.urls,
            services,
            warnings: [...warnings, ...hookWarnings],
        };
        if (previewUrl != null) output.previewUrl = previewUrl;
        if (primaryUrl != null) output.primaryUrl = primaryUrl;
        if (sdkAppUrl != null) output.sdkAppUrl = sdkAppUrl;

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
     *
     * There is no env-level failure finalizer on this path (the runner only logs),
     * so the target's terminal state is recorded here on the way out - see
     * `runScopedDeploy`.
     */
    private async deployScopedApp(
        input: DeployPreviewEnvironmentInput,
        appName: string,
        signal?: AbortSignal,
    ): Promise<DeployPreviewEnvironmentOutput> {
        try {
            return await this.runScopedDeploy(input, appName, signal);
        } catch (err) {
            // A supersede leaves the rows to the successor that now owns them
            // (mirrors `restartApp` and `markBuildSuperseded`).
            if (signal?.aborted === true) throw err;
            // Otherwise the target must not be left claiming to be in flight: a
            // throw before its terminal write (a failed pre-deploy hook, an infra
            // error) would strand the row at `built`/`deploying` forever. Scoped to
            // the target, and a row that already recorded a terminal state keeps its
            // own error.
            const error = err instanceof Error ? err.message : String(err);
            await recordSafe(() => failInFlightApps(input.namespace, error, appName));
            throw err;
        }
    }

    private async runScopedDeploy(
        input: DeployPreviewEnvironmentInput,
        appName: string,
        signal?: AbortSignal,
    ): Promise<DeployPreviewEnvironmentOutput> {
        const { event, imageTags, buildOutcomes, warnings } = input;
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
        await this.runPreDeployHooks(scopedHookConfig, namespace, repoFullName, prNumber, imageTags);

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
        const hookWarnings = await this.runPostDeployHooks(
            scopedHookConfig,
            result,
            new Set(ready ? [appName] : []),
            repoFullName,
            prNumber,
            imageTags,
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
            warnings: [...warnings, ...hookWarnings],
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
     * deployment + deployment status (for the Deployments UI and any BYO
     * `deployment_status` workflow). For PreviewKit-managed apps the diffs run is
     * started by the runner directly (Temporal, see `triggerDiffsAfterDeploy`),
     * not by this deployment event.
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
            logger.info("Finalize step 3/3 creating GitHub deployment + status (Deployments UI / BYO)", {
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
     * Failure finalizer - records the failed status/phase (environment row plus any
     * app row still in flight) and surfaces the error on the PR comment + commit
     * status. Best-effort: never throws.
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
        // Three independent sinks - the namespace annotations, the environment row,
        // and the app rows. The last one matters because the deploy can die before
        // step 6 writes the per-app terminal states (a failed pre-deploy hook or
        // database setup task is the common case): an app row left in flight keeps
        // the status rollups reading the environment as building.
        // Alongside them, the namespace's workloads are scaled to zero: a failed
        // environment gets no traffic to justify its pods, and one that failed
        // before the Gatekeeper handoff is not Gatekeeper-managed, so its infra
        // pods would otherwise run until the PR closes. The sleep uses the same
        // wake-replicas patch as Gatekeeper's own idle loop, so a wake request or
        // the next deploy restores everything - nothing is deleted.
        await Promise.all([
            this.deployer
                .updateStatus(repoFullName, prNumber, { status: "failed", phase: "failed", error })
                .catch((e) => logger.error("Failed to record failed status", e)),
            recordSafe(() => recordPhaseChanged({ namespace, status: "failed", phase: "failed", error })),
            recordSafe(() => failInFlightApps(namespace, error)),
            this.deployer
                .sleepWorkloads(namespace)
                .catch((e) => logger.error("Failed to scale failed environment's workloads to zero", e, { namespace })),
        ]);
        // The failure reason goes into the log stream itself, so a log tail (the
        // MCP get_build_logs / wait_for_deploy recentLogs, and the dashboard
        // viewer) ends with WHY - not just a bare "failed" marker. The fail-fast
        // paths (a skipped app, a partial build/deploy) otherwise leave a stream
        // whose last lines are a sibling's successful output.
        void this.logSink?.append(namespace, { kind: "log", message: `Deploy failed: ${error}` });
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
                    kind: "preview",
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

    /**
     * One clone plan per distinct non-primary `apps[].repository` value: the
     * branch the convention resolves to for this PR, and the repo's fallback
     * from its `repositories[]` settings entry (default `main`). The repo set
     * is derived from the apps - a `repositories[]` entry alone never clones.
     */
    private planDependencyClones(config: PreviewConfig, repoFullName: string, headRef: string): DependencyClonePlan[] {
        const settingsByRepo = new Map(config.repositories.map((settings) => [settings.repo.toLowerCase(), settings]));
        const dependencyRepos = new Map<string, string>();
        for (const app of config.apps) {
            if (isSameRepository(app.repository, repoFullName)) continue;
            dependencyRepos.set(app.repository.toLowerCase(), app.repository);
        }
        return [...dependencyRepos.values()].map((repo) => {
            const fallbackBranch = settingsByRepo.get(repo.toLowerCase())?.fallback_branch ?? "main";
            return {
                repo,
                fallbackBranch,
                targetBranch: resolveTargetBranch(headRef, config.branch_convention, fallbackBranch),
            };
        });
    }

    // Resolves the dependency repo's checkout (target branch, else fallback)
    // and clones it into a temp dir. Returns null when neither branch resolves -
    // the caller records the repo's apps as skipped.
    private async cloneDependency(plan: DependencyClonePlan, prNumber: number): Promise<DependencyEntry | null> {
        const resolved = await resolveDependencyCheckout(
            this.provider,
            plan.repo,
            plan.targetBranch,
            plan.fallbackBranch,
        );
        if (resolved == null) return null;

        const dirSlug = plan.repo.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const tmpDir = await mkdtemp(path.join(os.tmpdir(), `previewkit-${prNumber}-${dirSlug}-`));
        // Fetch at the resolved SHA, not the branch name: this pins the deployed
        // code to the exact commit recorded as provenance, even if the branch
        // moves between branch-head resolution and this fetch.
        await this.provider.fetchRepoTarball(plan.repo, resolved.sha, tmpDir);
        logger.info("Cloned dependency repo", {
            repo: plan.repo,
            branch: resolved.branch,
            sha: resolved.sha,
            usedFallback: resolved.usedFallback,
        });
        return {
            plan,
            tmpDir,
            usedFallback: resolved.usedFallback,
            sha: resolved.sha,
        };
    }

    private async buildAllApps(
        config: PreviewConfig,
        buildApps: AppConfig[],
        appRepoDirs: Map<string, string>,
        repoFullName: string,
        prNumber: number,
        shortSha: string,
        secretApps: Set<string>,
        applicationId: string,
        signal?: AbortSignal,
    ): Promise<Record<string, AppBuildOutcome>> {
        const [rawOrg, rawRepo] = repoFullName.split("/");
        const org = rawOrg!.toLowerCase();
        const repo = rawRepo!.toLowerCase();

        // Templating context for build_args. Resolves `{{name.host}}`,
        // `{{name.port}}`, `{{name.url}}`, `{{pr}}`, `{{namespace}}`, `{{owner}}` -
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
        // `buildApps` (a per-app redeploy's target, or every non-skipped app)
        // narrows which apps build, while the full `config` is kept so build-arg
        // templates can still reference siblings.
        const results = await Promise.allSettled(
            buildApps.map(async (app) => {
                const outcome = await this.buildOneApp(app, {
                    config,
                    appRepoDirs,
                    secretApps,
                    applicationId,
                    envInjector,
                    namespace,
                    templateContext,
                    publicUrlInfo,
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
     * `build_context: root` builds from the repo root. With no `build` block, the
     * app's bare `dockerfile` field (or a Dockerfile on disk at the app path) is
     * built via the same BuildKit Dockerfile path - there is no autodetection.
     * An app with neither a `build` block nor any Dockerfile fails with an
     * actionable error at dispatch (see `BuildKitBuilder.dispatchBuild`).
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
    } {
        const appDir = path.resolve(repoDir, app.path);

        // The `blueprint` (preset-based) deploy model takes precedence over `build`;
        // the schema makes them mutually exclusive. It is lowered to a `runtime`
        // Build and built by the existing single-stage generator (interim path).
        if (app.blueprint != null) {
            const facts = detectBlueprintFacts(app.blueprint, repoDir, app.path);
            const build = blueprintToBuild(app.blueprint, app.port, facts);
            // `root` (monorepo) builds from the repo root so sibling workspace packages resolve.
            const contextPath = build.build_context === "root" ? repoDir : appDir;
            // A bring-your-own Dockerfile blueprint is built as-is - no generation. Its path is
            // app-relative and the builder resolves against the context, so a root build joins
            // the app path back in.
            if (build.framework === "dockerfile") {
                const dockerfile =
                    build.build_context === "root"
                        ? path.posix.join(facts.appPath, build.dockerfile)
                        : build.dockerfile;
                return { contextPath, dockerfile, target: build.target };
            }
            const generatedDockerfile = generateDockerfile(build, {
                registryMirror: this.dockerHubMirror,
                npmRegistryMirror: this.npmRegistryMirror,
                buildArgs: resolvedBuildArgs,
                port: app.port,
                appName: app.name,
                appPath: facts.appPath,
            });
            return { contextPath, generatedDockerfile };
        }

        if (app.build != null) {
            const build = app.build;
            const contextPath = build.build_context === "root" ? repoDir : appDir;
            if (build.framework === "dockerfile") {
                return { contextPath, dockerfile: build.dockerfile, target: build.target };
            }
            const generatedDockerfile = generateDockerfile(build, {
                registryMirror: this.dockerHubMirror,
                npmRegistryMirror: this.npmRegistryMirror,
                buildArgs: resolvedBuildArgs,
                port: app.port,
                appName: app.name,
                turboFilter: resolveBuildTurboFilter(build, repoDir, app.path),
            });
            return { contextPath, generatedDockerfile };
        }

        const buildContext = app.build_context != null ? path.resolve(repoDir, app.build_context) : undefined;
        return {
            contextPath: appDir,
            ...(buildContext != null ? { buildContext } : {}),
            ...(app.dockerfile != null ? { dockerfile: app.dockerfile } : {}),
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
            if (app.build_secrets.length > 0 && !ctx.secretApps.has(app.name)) {
                const registered = [...ctx.secretApps].sort();
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
            });
            const cacheRef = buildPreviewCacheReference({
                registry: ctx.registry,
                org: ctx.org,
                repo: ctx.repo,
                appName: app.name,
            });
            const dir = ctx.appRepoDirs.get(app.name);
            if (dir == null) throw new Error(`No repo directory found for app "${app.name}"`);
            const secretBuildArgs =
                app.build_secrets.length > 0
                    ? await this.buildSecrets.forKeys(
                          { kind: "app", applicationId: ctx.applicationId, appName: app.name },
                          app.build_secrets,
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
            );

            const buildInputs = this.resolveBuildInputs(app, dir, resolvedBuildArgs);
            const result = await this.builder.build({
                appName: app.name,
                contextPath: buildInputs.contextPath,
                buildArgs: resolvedBuildArgs,
                imageTag,
                cacheRef,
                namespace: ctx.namespace,
                repo: `${ctx.org}/${ctx.repo}`,
                pr: ctx.prNumber,
                buildContext: buildInputs.buildContext,
                dockerfile: buildInputs.dockerfile,
                target: buildInputs.target,
                generatedDockerfile: buildInputs.generatedDockerfile,
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
            .resolveConnections(appConfig.connections, config.apps, config.services, namespace, context, publicUrlInfo);
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
    ): Promise<void> {
        if (config.hooks.pre_deploy.length === 0) return;

        logger.info("Running pre-deploy hooks", { namespace, hooks: config.hooks.pre_deploy.length });

        for (const hook of config.hooks.pre_deploy) {
            logger.info("Executing pre-deploy hook Job", { namespace, app: hook.app, command: hook.command });
            await this.runHookJobStep(hook, config, namespace, repoFullName, prNumber, imageTags);
            logger.info("Finished pre-deploy hook Job", { namespace, app: hook.app, command: hook.command });
        }
        logger.info("Finished running pre-deploy hooks", { namespace, hooks: config.hooks.pre_deploy.length });
    }

    /**
     * Runs the post-deploy hooks whose app came up. A failure here is non-fatal (the
     * apps are already serving), so instead of aborting it is returned as a
     * PR-comment warning - otherwise the failure would only ever exist in Sentry and
     * the deploy would report a clean success.
     */
    private async runPostDeployHooks(
        config: PreviewConfig,
        result: DeployResult,
        readyAppNames: Set<string>,
        repoFullName: string,
        prNumber: number,
        imageTags: Record<string, string>,
    ): Promise<string[]> {
        if (config.hooks.post_deploy.length === 0) return [];

        const runnable = config.hooks.post_deploy.filter((h) => readyAppNames.has(h.app));
        const skipped = config.hooks.post_deploy.filter((h) => !readyAppNames.has(h.app));
        for (const hook of skipped) {
            logger.info("Skipping post-deploy hook: target app did not come up", {
                app: hook.app,
                command: hook.command,
            });
        }
        if (runnable.length === 0) return [];

        logger.info("Running post-deploy hooks", {
            namespace: result.namespace,
            hooks: runnable.length,
        });

        const warnings: string[] = [];
        for (const hook of runnable) {
            logger.info("Executing post-deploy hook Job", { app: hook.app, command: hook.command });
            try {
                await this.runHookJobStep(hook, config, result.namespace, repoFullName, prNumber, imageTags);
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
                warnings.push(summarizeHookFailure(hook.app, hook.command, err));
            }
        }
        logger.info("Finished running post-deploy hooks", {
            namespace: result.namespace,
            hooks: runnable.length,
            failed: warnings.length,
        });
        return warnings;
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
                await this.runSetupTaskStep(task, service.name, config, namespace, repoFullName, prNumber, imageTags);
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
            .resolveConnections(appConfig.connections, config.apps, config.services, namespace, context, publicUrlInfo);
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

        const serviceErrorDetails = result.services
            .filter((service) => service.error != null && service.error !== "")
            .map((service) => ({ summary: `${service.name} - error`, body: service.error! }));

        // The visible "See preview" CTA points at the front door, which forks a
        // browser (-> waiting page) from an agent (-> 307 to the raw URL). The raw
        // URL still rides along in the hidden machine-readable block so an agent
        // reading the comment body has a direct link.
        const previewUrl = result.previewUrl;
        return payloadBuilder({
            state: result.ready ? "running" : "critical",
            kind: "preview",
            prNumber,
            commitSha: headSha,
            assetBaseUrl: resolvePreviewkitCommentAssetBaseUrl(),
            previewUrl: previewUrl != null ? buildPreviewFrontDoorUrl(env.APP_URL, previewUrl) : undefined,
            previewUrls: previewUrl != null ? [previewUrl] : [],
            message: result.ready
                ? "Preview is ready. Autonoma can run the selected tests against this commit."
                : `${result.readyCount}/${result.totalCount} preview services are ready. Autonoma cannot run the full sweep yet.`,
            services,
            warnings: result.warnings,
            details: serviceErrorDetails,
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
 * Collapses a failed post-deploy hook into one PR-comment warning line. The
 * interesting part of a hook error is the tail of the Job's log, so the last few
 * non-empty lines are joined onto a single line and truncated; the full output is
 * already in the build-log viewer (every hook line is relayed there).
 */
function summarizeHookFailure(app: string, command: string, err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    const lines = message
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    const tail = lines.slice(-HOOK_WARNING_TAIL_LINES).join(" | ");
    const detail = tail.length > HOOK_WARNING_MAX_CHARS ? `${tail.slice(0, HOOK_WARNING_MAX_CHARS)}...` : tail;
    return `Post-deploy hook for "${app}" failed, deploy continued: ${command} - ${detail}`;
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
