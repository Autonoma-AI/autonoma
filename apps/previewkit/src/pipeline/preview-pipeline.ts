import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "@autonoma/db";
import { BuildError, type Builder } from "../builder/builder";
import { loadPreviewConfig } from "../config/config-loader";
import type { BranchConvention, PreviewConfig, RepoDependency } from "../config/schema";
import {
    type AppBuildOutcome,
    isGithubFeedbackEnabledForOrg,
    recordBuildFinished,
    recordEnvironmentCreated,
    recordEnvironmentReady,
    recordPhaseChanged,
    toAppInstances,
} from "../db";
import type { AppDeployOutcome, Deployer } from "../deployer/deployer";
import { type DeployResult } from "../deployer/deployer";
import type { EnvInjector, PublicUrlInfo } from "../deployer/env-injector";
import { execInDeploymentPod } from "../deployer/pod-exec";
import type { DiffsClient } from "../diffs/diffs-client";
import { resolvePrimaryUrl } from "../diffs/resolve-primary-url";
import type { PullRequestEvent } from "../git-provider/git-provider";
import type { GitProvider } from "../git-provider/git-provider";
import { logger } from "../logger";
import { resolveTargetBranch } from "../multirepo/resolve-target-branch";
import type { AwsSecretsFetcher } from "../secrets/aws-secrets-fetcher";
import type { SecretStore } from "../secrets/secret-store";

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
    envInjector: EnvInjector;
    namespace: string;
    templateContext: { pr: string; namespace: string; owner: string };
    publicUrlInfo: PublicUrlInfo;
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
    secretStore: SecretStore;
    awsSecretsFetcher: AwsSecretsFetcher;
    registryUrl: string;
    diffsClient?: DiffsClient;
}

export class PreviewPipeline {
    private readonly provider: GitProvider;
    private readonly builder: Builder;
    private readonly deployer: Deployer;
    private readonly secretStore: SecretStore;
    private readonly awsSecretsFetcher: AwsSecretsFetcher;
    private readonly registryUrl: string;
    private readonly diffsClient?: DiffsClient;

    constructor(options: PreviewPipelineOptions) {
        this.provider = options.provider;
        this.builder = options.builder;
        this.deployer = options.deployer;
        this.secretStore = options.secretStore;
        this.awsSecretsFetcher = options.awsSecretsFetcher;
        this.registryUrl = options.registryUrl;
        this.diffsClient = options.diffsClient;
    }

    async deploy(event: PullRequestEvent): Promise<void> {
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

        // 2. Check that the repo opted in to Previewkit before we touch anything.
        //    A missing `.preview.yaml` is the second normal opt-out signal — repos
        //    linked to an Application but not yet using Previewkit skip cleanly.
        const primaryConfig = await loadPreviewConfig(this.provider, repoFullName, headSha);
        if (primaryConfig == null) {
            logger.warn("No .preview.yaml found at ref; skipping deployment", {
                repo: repoFullName,
                pr: prNumber,
                sha: shortSha,
            });
            return;
        }

        // 1c. Per-org toggle: when false, the pipeline still runs end-to-end but stays quiet on GitHub.
        const feedbackEnabled = await isGithubFeedbackEnabledForOrg(organizationId);
        if (!feedbackEnabled) {
            logger.info("GitHub feedback disabled for organization; skipping comments + commit statuses", {
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
            const pendingBody = this.buildPendingComment(prNumber);
            const existing = await db.previewkitEnvironment.findUnique({
                where: { repoFullName_prNumber: { repoFullName, prNumber } },
                select: { commentId: true },
            });

            if (existing?.commentId != null && existing.commentId !== "") {
                commentId = existing.commentId;
                await this.provider.updateComment(repoFullName, commentId, pendingBody).catch((err) => {
                    // Existing comment was deleted on GitHub (or we lack
                    // permissions). Drop the stale id; the block below will
                    // post a fresh one and overwrite the stored value.
                    logger.warn("Failed to update existing PR comment; posting a fresh one", {
                        repo: repoFullName,
                        pr: prNumber,
                        commentId,
                        err: err instanceof Error ? err.message : String(err),
                    });
                    commentId = "";
                });
            }

            if (commentId === "") {
                commentId = await this.provider.postComment(repoFullName, prNumber, pendingBody).catch((_e) => {
                    logger.warn("Failed to post initial PR comment", { repo: repoFullName, pr: prNumber });
                    return "";
                });
            }
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

        let primaryDir: string | undefined;
        let dependencyEntries: DependencyEntry[] = [];

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

            // 8. Load stored secrets per app, using the correct org owner for each repo.
            const primaryOwner = repoFullName.split("/")[0]!;
            const appToOwner = new Map<string, string>();
            for (const app of primaryConfig.apps) appToOwner.set(app.name, primaryOwner);
            for (const entry of dependencyEntries) {
                const depOwner = entry.dep.repo.split("/")[0]!;
                for (const app of entry.config.apps) appToOwner.set(app.name, depOwner);
            }
            const storedSecrets: Record<string, Record<string, string>> = {};
            for (const app of mergedConfig.apps) {
                const owner = appToOwner.get(app.name) ?? primaryOwner;
                storedSecrets[app.name] = await this.secretStore.getMerged(owner, app.name, prNumber);
            }

            // 9. Build all app images in parallel. Per-app build failures are
            //    captured into the outcome map rather than thrown — only the
            //    "every app failed" case aborts the pipeline as a global error.
            await this.updatePhase(repoFullName, prNumber, "building", "building-images");
            const buildStart = Date.now();
            const arnByApp = new Map<string, string>();
            for (const s of application.previewkitSecrets) {
                if (s.appName != null) arnByApp.set(s.appName, s.awsSecretArn);
            }
            const appBuilds = await this.buildAllApps(
                mergedConfig,
                appRepoDirs,
                repoFullName,
                prNumber,
                shortSha,
                arnByApp,
            );
            const buildDurationMs = Date.now() - buildStart;

            const imageTags: Record<string, string> = {};
            for (const [name, outcome] of Object.entries(appBuilds)) {
                if (outcome.status === "ok") imageTags[name] = outcome.imageTag;
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

            // 10. Deploy. The deployer also runs each app independently — one
            //     app's K8s apply or readiness failure does not abort the rest.
            await this.updatePhase(repoFullName, prNumber, "deploying", "deploying-k8s");
            const result = await this.deployer.deploy({
                repoFullName,
                prNumber,
                headSha,
                organizationId,
                githubRepositoryId,
                config: mergedConfig,
                imageTags,
                storedSecrets,
                commentId,
            });

            // 11. Aggregate per-app outcomes for downstream reporting + decisions.
            const finalOutcomes = this.computeFinalOutcomes(mergedConfig, appBuilds, result.appOutcomes);
            const readyAppNames = new Set(finalOutcomes.filter((o) => o.status === "ok").map((o) => o.name));
            const readyCount = readyAppNames.size;
            const totalCount = finalOutcomes.length;

            // 12. Run post-deploy hooks only for apps that came up. Hooks that
            //     target a failed app would fail at `kubectl exec` time with
            //     "no pod" — better to skip silently than poison the pipeline.
            await this.updatePhase(repoFullName, prNumber, "deploying", "post-deploy-hooks");
            await this.runPostDeployHooks(mergedConfig, result, readyAppNames);

            // 13. If nothing came up, treat as a global failure. Otherwise mark
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
                    apps: toAppInstances(mergedConfig.apps, imageTags),
                }),
            );

            // 14. Update PR comment with per-app status table.
            if (feedbackEnabled && commentId !== "") {
                const fallbackDeps = dependencyEntries.filter((e) => e.usedFallback);
                await this.provider.updateComment(
                    repoFullName,
                    commentId,
                    this.buildResultComment(
                        prNumber,
                        finalOutcomes,
                        mergedConfig,
                        readyCount,
                        totalCount,
                        fallbackDeps,
                    ),
                );
            }

            // 15. Single global commit status. Success only when every app
            //     came up; otherwise failure with an "N/M ready" description.
            //     Per-app contexts (`previewkit/<app>`) are a Stage B follow-up.
            if (feedbackEnabled) {
                const allReady = readyCount === totalCount;
                const firstReadyUrl = finalOutcomes.find((o) => o.status === "ok")?.url;
                await this.provider.setCommitStatus(
                    repoFullName,
                    headSha,
                    allReady ? "success" : "failure",
                    allReady ? "Preview environment ready" : `${readyCount}/${totalCount} apps ready`,
                    firstReadyUrl,
                );
            }

            // 15. Trigger diffs analysis
            const diffsClient = this.diffsClient;
            if (diffsClient != null) {
                const primaryUrl = resolvePrimaryUrl(primaryConfig.apps, result.urls);
                if (primaryUrl != null) {
                    await diffsClient
                        .triggerPrDiffs({
                            organizationId,
                            repoId: githubRepositoryId,
                            prNumber,
                            url: primaryUrl,
                        })
                        .catch((err) => {
                            logger.fatal("Failed to trigger diffs analysis", err, {
                                repo: repoFullName,
                                pr: prNumber,
                            });
                        });
                } else {
                    logger.fatal("No primary URL resolved for diffs trigger", {
                        repo: repoFullName,
                        pr: prNumber,
                        availableUrls: Object.keys(result.urls),
                    });
                }
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
                await this.provider
                    .updateComment(repoFullName, commentId, this.buildFailureComment(prNumber, err))
                    .catch((e) => logger.error("Failed to update failure comment", e));
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
    ): Promise<Record<string, AppBuildOutcome>> {
        const [rawOrg, rawRepo] = repoFullName.split("/");
        const org = rawOrg!.toLowerCase();
        const repo = rawRepo!.toLowerCase();

        // Templating context for build_args. Resolves `{{name.host}}`,
        // `{{name.port}}`, `{{name.url}}`, `{{pr}}`, `{{namespace}}`, `{{owner}}`
        // — same grammar the deployer applies to runtime env. The URL form is
        // what makes Vite-baked VITE_*_URL vars point at this PR's specific
        // services (e.g. `https://anvil-pr-42-acme-foo.preview.autonoma.app`).
        const namespace = this.deployer.getNamespaceName(repoFullName, prNumber);
        const templateContext = { pr: String(prNumber), namespace, owner: org };
        const publicUrlInfo = {
            domain: config.domain ?? this.deployer.getDomain(),
            repoSlug: this.deployer.buildRepoSlug(repoFullName),
            prNumber,
        };
        const envInjector = this.deployer.getEnvInjector();
        const registry = config.registry ?? this.registryUrl;

        // Each app is built independently — a failure in one app is captured
        // into its own outcome and does not abort the other builds. `buildOneApp`
        // never throws, so we don't need allSettled here.
        const entries = await Promise.all(
            config.apps.map(async (app) => {
                const outcome = await this.buildOneApp(app, {
                    config,
                    appRepoDirs,
                    arnByApp,
                    envInjector,
                    namespace,
                    templateContext,
                    publicUrlInfo,
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
                throw new Error(
                    `App "${app.name}" declares build_secrets but no PreviewkitSecret is registered for it. ` +
                        `Register a PreviewkitSecret row with appName="${app.name}" pointing at the app's AWS SM ARN.`,
                );
            }

            const imageTag = `${ctx.registry}/${ctx.org}/${ctx.repo}:${app.name}-pr-${ctx.prNumber}-${ctx.shortSha}`;
            const dir = ctx.appRepoDirs.get(app.name);
            if (dir == null) throw new Error(`No repo directory found for app "${app.name}"`);
            const contextPath = path.resolve(dir, app.path);
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
            );

            const result = await this.builder.build({
                appName: app.name,
                contextPath,
                dockerfile: app.dockerfile,
                buildArgs: resolvedBuildArgs,
                imageTag,
                cacheKey,
            });

            return { status: "ok", imageTag: result.imageTag, durationMs: result.durationMs, logUrl: result.logUrl };
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

    private async runPostDeployHooks(
        config: PreviewConfig,
        result: DeployResult,
        readyAppNames: Set<string>,
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
            logger.info("Executing post-deploy hook", { app: hook.app, command: hook.command });

            const { stdout, stderr } = await execInDeploymentPod(kc, result.namespace, hook.app, hook.command);
            if (stdout) logger.info("Post-deploy hook stdout", { app: hook.app, stdout });
            if (stderr) logger.warn("Post-deploy hook stderr", { app: hook.app, stderr });
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

    private buildPendingComment(prNumber: number): string {
        return [
            `## Preview Environment #${prNumber}`,
            "",
            "**Status:** Building...",
            "",
            "Your preview environment is being built and deployed. This may take a few minutes.",
        ].join("\n");
    }

    /**
     * Renders the per-app status table after the pipeline has completed. Shows
     * one row per app with status, URL (when the deploy actually applied
     * resources), and a link to the build log when one was captured.
     *
     * Per-app error messages are emitted as collapsed `<details>` blocks under
     * the table so the comment stays readable when several apps fail.
     */
    private buildResultComment(
        prNumber: number,
        outcomes: AppFinalOutcome[],
        config: PreviewConfig,
        readyCount: number,
        totalCount: number,
        fallbackDeps: DependencyEntry[],
    ): string {
        const statusLine =
            readyCount === totalCount ? "**Status:** Ready" : `**Status:** ${readyCount}/${totalCount} apps ready`;

        const rows = outcomes
            .map((o) => {
                const status = o.status === "ok" ? "Ready" : "Failed";
                const url = o.url != null ? o.url : "-";
                const logs = o.buildLogUrl != null ? `[view](${o.buildLogUrl})` : "-";
                return `| ${o.name} | ${status} | ${url} | ${logs} |`;
            })
            .join("\n");

        const errorBlocks = outcomes
            .filter((o) => o.status === "failed" && o.error != null)
            .map((o) =>
                ["<details>", `<summary>${o.name} - error</summary>`, "", "```", o.error, "```", "</details>"].join(
                    "\n",
                ),
            );

        const serviceLines = config.services
            .map((s) => `- ${s.name} (${s.recipe}${s.version ? `:${s.version}` : ""})`)
            .join("\n");

        const sections: string[] = [
            `## Preview Environment #${prNumber}`,
            "",
            statusLine,
            "",
            "| App | Status | URL | Build logs |",
            "|-----|--------|-----|------------|",
            rows,
        ];

        if (errorBlocks.length > 0) {
            sections.push("", ...errorBlocks);
        }

        if (serviceLines.length > 0) {
            sections.push("", "**Services:**", serviceLines);
        }

        if (fallbackDeps.length > 0) {
            sections.push(
                "",
                "> **Note:** Some backend branches were not found. The fallback branch was used instead:",
                ...fallbackDeps.map(
                    (e) =>
                        `> - \`${e.dep.repo}\` - branch \`${e.targetBranch}\` not found, using \`${e.dep.fallback_branch}\``,
                ),
            );
        }

        return sections.join("\n");
    }

    private buildFailureComment(prNumber: number, err: unknown): string {
        const message = err instanceof Error ? err.message : "Unknown error occurred";
        return [`## Preview Environment #${prNumber}`, "", "**Status:** Failed", "", "```", message, "```"].join("\n");
    }
}

async function recordSafe(fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        logger.error("Failed to record Previewkit DB event", err);
    }
}
