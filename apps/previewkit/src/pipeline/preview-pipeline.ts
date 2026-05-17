import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "@autonoma/db";
import type { Builder } from "../builder/builder";
import { loadPreviewConfig } from "../config/config-loader";
import type { PreviewConfig, RepoDependency } from "../config/schema";
import {
    isGithubFeedbackEnabledForOrg,
    recordBuildFinished,
    recordEnvironmentCreated,
    recordEnvironmentReady,
    recordPhaseChanged,
    toAppInstances,
} from "../db";
import type { Deployer } from "../deployer/deployer";
import { type DeployResult } from "../deployer/deployer";
import { execInDeploymentPod } from "../deployer/pod-exec";
import type { PullRequestEvent } from "../git-provider/git-provider";
import type { GitProvider } from "../git-provider/git-provider";
import { logger } from "../logger";
import type { AwsSecretsFetcher } from "../secrets/aws-secrets-fetcher";
import type { SecretStore } from "../secrets/secret-store";

interface AppBuildResult {
    imageTag: string;
    durationMs: number;
    logUrl: string;
}

interface BackendEntry {
    dep: RepoDependency;
    config: PreviewConfig;
    tmpDir: string;
}

interface PreviewPipelineOptions {
    provider: GitProvider;
    builder: Builder;
    deployer: Deployer;
    secretStore: SecretStore;
    awsSecretsFetcher: AwsSecretsFetcher;
    registryUrl: string;
}

export class PreviewPipeline {
    private provider: GitProvider;
    private builder: Builder;
    private deployer: Deployer;
    private secretStore: SecretStore;
    private awsSecretsFetcher: AwsSecretsFetcher;
    private registryUrl: string;

    constructor(options: PreviewPipelineOptions) {
        this.provider = options.provider;
        this.builder = options.builder;
        this.deployer = options.deployer;
        this.secretStore = options.secretStore;
        this.awsSecretsFetcher = options.awsSecretsFetcher;
        this.registryUrl = options.registryUrl;
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
                previewkitSecret: { select: { awsSecretArn: true } },
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
        const frontendConfig = await loadPreviewConfig(this.provider, repoFullName, headSha);
        if (frontendConfig == null) {
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

        // 3. Post initial comment (best-effort — fails silently if app lacks Issues permission)
        const commentId = feedbackEnabled
            ? await this.provider
                  .postComment(repoFullName, prNumber, this.buildPendingComment(prNumber))
                  .catch((_e) => {
                      logger.warn("Failed to post initial PR comment", { repo: repoFullName, pr: prNumber });
                      return "";
                  })
            : "";

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
                commentId,
            }),
        );

        let frontendDir: string | undefined;
        let backendEntries: BackendEntry[] = [];

        try {
            // 5. Clone frontend repo and all backend repos in parallel.
            await this.updatePhase(repoFullName, prNumber, "pending", "cloning");
            frontendDir = await mkdtemp(path.join(os.tmpdir(), `previewkit-${prNumber}-`));
            const backendDeps = frontendConfig.config?.multirepo?.repos ?? [];
            const [backendResults] = await Promise.all([
                Promise.all(backendDeps.map((dep) => this.cloneBackendRepo(dep, prNumber))),
                this.provider.fetchRepoTarball(repoFullName, headSha, frontendDir),
            ]);
            backendEntries = backendResults.filter((e): e is BackendEntry => e != null);

            // 6. Merge all configs into a single config for building and deploying.
            const mergedConfig = this.mergeConfigs(frontendConfig, backendEntries);

            // 7. Build appRepoDirs: maps each app name to the directory it should be built from.
            const appRepoDirs = new Map<string, string>();
            for (const app of frontendConfig.apps) {
                appRepoDirs.set(app.name, frontendDir);
            }
            for (const entry of backendEntries) {
                for (const app of entry.config.apps) {
                    appRepoDirs.set(app.name, entry.tmpDir);
                }
            }

            // 8. Load stored secrets per app, using the correct org owner for each repo.
            const frontendOwner = repoFullName.split("/")[0]!;
            const appToOwner = new Map<string, string>();
            for (const app of frontendConfig.apps) appToOwner.set(app.name, frontendOwner);
            for (const entry of backendEntries) {
                const backendOwner = entry.dep.repo.split("/")[0]!;
                for (const app of entry.config.apps) appToOwner.set(app.name, backendOwner);
            }
            const storedSecrets: Record<string, Record<string, string>> = {};
            for (const app of mergedConfig.apps) {
                const owner = appToOwner.get(app.name) ?? frontendOwner;
                storedSecrets[app.name] = await this.secretStore.getMerged(owner, app.name, prNumber);
            }

            // 9. Build all app images in parallel.
            await this.updatePhase(repoFullName, prNumber, "building", "building-images");
            const buildStart = Date.now();
            let appBuilds: Record<string, AppBuildResult>;
            try {
                appBuilds = await this.buildAllApps(
                    mergedConfig,
                    appRepoDirs,
                    repoFullName,
                    prNumber,
                    shortSha,
                    application.previewkitSecret?.awsSecretArn,
                );
            } catch (buildErr) {
                await recordSafe(() =>
                    recordBuildFinished({
                        namespace,
                        headSha,
                        status: "failed",
                        durationMs: Date.now() - buildStart,
                        appBuilds: {},
                        error: buildErr instanceof Error ? buildErr.message : String(buildErr),
                    }),
                );
                throw buildErr;
            }
            const buildDurationMs = Date.now() - buildStart;
            const imageTags = Object.fromEntries(Object.entries(appBuilds).map(([name, b]) => [name, b.imageTag]));

            await recordSafe(() =>
                recordBuildFinished({
                    namespace,
                    headSha,
                    status: "building",
                    durationMs: buildDurationMs,
                    appBuilds,
                }),
            );

            // 10. Deploy everything into one namespace, respecting depends_on order.
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

            // 11. Run post-deploy hooks
            await this.updatePhase(repoFullName, prNumber, "deploying", "post-deploy-hooks");
            await this.runPostDeployHooks(mergedConfig, result);

            // 12. Mark ready + record URLs
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

            // 13. Update comment with preview URLs (skip if no comment was created)
            if (feedbackEnabled && commentId !== "") {
                await this.provider.updateComment(
                    repoFullName,
                    commentId,
                    this.buildSuccessComment(prNumber, result, mergedConfig),
                );
            }

            // 14. Set commit status to success
            if (feedbackEnabled) {
                const firstUrl = Object.values(result.urls)[0];
                await this.provider.setCommitStatus(
                    repoFullName,
                    headSha,
                    "success",
                    "Preview environment ready",
                    firstUrl,
                );
            }

            logger.info("Preview deployment complete", { repo: repoFullName, pr: prNumber, urls: result.urls });
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
            const dirsToClean = [frontendDir, ...backendEntries.map((e) => e.tmpDir)].filter((d) => d != null);
            await Promise.all(dirsToClean.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
        }
    }

    // Fetches the .preview.yaml from a backend repo and clones it into a temp dir.
    // Returns null if the repo has no .preview.yaml (opt-out — skip silently).
    private async cloneBackendRepo(dep: RepoDependency, prNumber: number): Promise<BackendEntry | null> {
        const config = await loadPreviewConfig(this.provider, dep.repo, dep.fallback_branch);
        if (config == null) {
            logger.warn("No .preview.yaml found for backend repo dependency, skipping", {
                name: dep.name,
                repo: dep.repo,
                branch: dep.fallback_branch,
            });
            return null;
        }
        const tmpDir = await mkdtemp(path.join(os.tmpdir(), `previewkit-${prNumber}-${dep.name}-`));
        await this.provider.fetchRepoTarball(dep.repo, dep.fallback_branch, tmpDir);
        logger.info("Cloned backend repo", { name: dep.name, repo: dep.repo, branch: dep.fallback_branch });
        return { dep, config, tmpDir };
    }

    private mergeConfigs(frontendConfig: PreviewConfig, backends: BackendEntry[]): PreviewConfig {
        return {
            ...frontendConfig,
            apps: [...frontendConfig.apps, ...backends.flatMap((b) => b.config.apps)],
            services: [...frontendConfig.services, ...backends.flatMap((b) => b.config.services)],
            hooks: {
                post_deploy: [
                    ...frontendConfig.hooks.post_deploy,
                    ...backends.flatMap((b) => b.config.hooks.post_deploy),
                ],
            },
        };
    }

    private async buildAllApps(
        config: PreviewConfig,
        appRepoDirs: Map<string, string>,
        repoFullName: string,
        prNumber: number,
        shortSha: string,
        awsSecretArn: string | undefined,
    ): Promise<Record<string, AppBuildResult>> {
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

        const needsAwsSecrets = config.apps.some((app) => app.build_secrets.length > 0);
        if (needsAwsSecrets && awsSecretArn == null) {
            throw new Error(
                "build_secrets requested but no PreviewkitSecret is registered for this Application " +
                    "(needed to resolve the AWS Secrets Manager ARN)",
            );
        }
        const awsSecretMap =
            needsAwsSecrets && awsSecretArn != null ? await this.awsSecretsFetcher.fetchJson(awsSecretArn) : {};

        const entries = await Promise.all(
            config.apps.map(async (app) => {
                const registry = config.registry ?? this.registryUrl;
                const imageTag = `${registry}/${org}/${repo}:${app.name}-pr-${prNumber}-${shortSha}`;
                const dir = appRepoDirs.get(app.name);
                if (dir == null) throw new Error(`No repo directory found for app "${app.name}"`);
                const contextPath = path.resolve(dir, app.path);
                const cacheKey = `${org}/${repo}/${app.name}`;

                const secretBuildArgs =
                    app.build_secrets.length > 0
                        ? this.awsSecretsFetcher.pickKeys(awsSecretMap, app.build_secrets, awsSecretArn!)
                        : {};
                const mergedBuildArgs: Record<string, string> = { ...secretBuildArgs, ...app.build_args };

                const resolvedBuildArgs = envInjector.applyTemplates(
                    mergedBuildArgs,
                    config.apps,
                    config.services,
                    namespace,
                    templateContext,
                    publicUrlInfo,
                );

                const result = await this.builder.build({
                    appName: app.name,
                    contextPath,
                    dockerfile: app.dockerfile,
                    buildArgs: resolvedBuildArgs,
                    imageTag,
                    cacheKey,
                });

                return [
                    app.name,
                    { imageTag: result.imageTag, durationMs: result.durationMs, logUrl: result.logUrl },
                ] as const;
            }),
        );

        return Object.fromEntries(entries);
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

    private async runPostDeployHooks(config: PreviewConfig, result: DeployResult): Promise<void> {
        if (config.hooks.post_deploy.length === 0) return;

        logger.info("Running post-deploy hooks", {
            namespace: result.namespace,
            hooks: config.hooks.post_deploy.length,
        });

        const kc = this.deployer.getKubeConfig();
        for (const hook of config.hooks.post_deploy) {
            logger.info("Executing post-deploy hook", { app: hook.app, command: hook.command });

            const { stdout, stderr } = await execInDeploymentPod(kc, result.namespace, hook.app, hook.command);
            if (stdout) logger.info("Post-deploy hook stdout", { app: hook.app, stdout });
            if (stderr) logger.warn("Post-deploy hook stderr", { app: hook.app, stderr });
        }
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

    private buildSuccessComment(prNumber: number, result: DeployResult, config: PreviewConfig): string {
        const urlLines = Object.entries(result.urls)
            .map(([app, url]) => `| ${app} | ${url} |`)
            .join("\n");

        const serviceLines = config.services
            .map((s) => `- ${s.name} (${s.recipe}${s.version ? `:${s.version}` : ""})`)
            .join("\n");

        return [
            `## Preview Environment #${prNumber}`,
            "",
            "**Status:** Ready",
            "",
            "| App | URL |",
            "|-----|-----|",
            urlLines,
            "",
            ...(serviceLines ? ["**Services:**", serviceLines] : []),
        ].join("\n");
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
