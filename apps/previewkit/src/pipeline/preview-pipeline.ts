import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Builder } from "../builder/builder";
import { loadPreviewConfig } from "../config/config-loader";
import type { PreviewConfig } from "../config/schema";
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
import type { SecretStore } from "../secrets/secret-store";
import type { OrganizationResolver } from "../tenancy/organization-resolver";

interface AppBuildResult {
    imageTag: string;
    durationMs: number;
}

interface PreviewPipelineOptions {
    provider: GitProvider;
    builder: Builder;
    deployer: Deployer;
    secretStore: SecretStore;
    organizationResolver: OrganizationResolver;
    registryUrl: string;
}

export class PreviewPipeline {
    private provider: GitProvider;
    private builder: Builder;
    private deployer: Deployer;
    private secretStore: SecretStore;
    private organizationResolver: OrganizationResolver;
    private registryUrl: string;

    constructor(options: PreviewPipelineOptions) {
        this.provider = options.provider;
        this.builder = options.builder;
        this.deployer = options.deployer;
        this.secretStore = options.secretStore;
        this.organizationResolver = options.organizationResolver;
        this.registryUrl = options.registryUrl;
    }

    async deploy(event: PullRequestEvent): Promise<void> {
        const { repoFullName, prNumber, headSha } = event;
        const shortSha = headSha.slice(0, 7);

        logger.info("Starting preview deployment", { repo: repoFullName, pr: prNumber, sha: shortSha });

        // 1. Resolve tenant. Rejects deployment if the repo is not linked to an active installation.
        const organizationId = await this.organizationResolver.resolveByRepoFullName(repoFullName);

        // 1b. Per-org toggle: when false, the pipeline still runs end-to-end but stays quiet on GitHub.
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

        // 3b. Record environment created in the DB (best-effort).
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

        let tmpDir: string | undefined;

        try {
            // 4. Load config from repo
            await this.updatePhase(repoFullName, prNumber, "pending", "loading-config");
            const config = await loadPreviewConfig(this.provider, repoFullName, headSha);

            // 5. Clone repo
            await this.updatePhase(repoFullName, prNumber, "pending", "cloning");
            tmpDir = await mkdtemp(path.join(os.tmpdir(), `previewkit-${prNumber}-`));
            await this.cloneRepo(event, tmpDir);

            // 6. Load stored secrets per app (baseline owner+app merged with PR-scoped overrides)
            const owner = repoFullName.split("/")[0]!;
            const storedSecrets: Record<string, Record<string, string>> = {};
            for (const app of config.apps) {
                storedSecrets[app.name] = await this.secretStore.getMerged(owner, app.name, prNumber);
            }

            // 7. Build all app images
            await this.updatePhase(repoFullName, prNumber, "building", "building-images");
            const buildStart = Date.now();
            let appBuilds: Record<string, AppBuildResult>;
            try {
                appBuilds = await this.buildAllApps(config, tmpDir, repoFullName, prNumber, shortSha);
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

            // 8. Deploy to Kubernetes
            await this.updatePhase(repoFullName, prNumber, "deploying", "deploying-k8s");
            const result = await this.deployer.deploy({
                repoFullName,
                prNumber,
                headSha,
                organizationId,
                config,
                imageTags,
                storedSecrets,
                commentId,
            });

            // 9. Run post-deploy hooks
            await this.updatePhase(repoFullName, prNumber, "deploying", "post-deploy-hooks");
            await this.runPostDeployHooks(config, result);

            // 10. Mark ready + record URLs
            await this.deployer.updateStatus(repoFullName, prNumber, {
                status: "ready",
                phase: "ready",
                urls: result.urls,
            });
            await recordSafe(() =>
                recordEnvironmentReady({
                    namespace,
                    urls: result.urls,
                    apps: toAppInstances(config.apps, imageTags),
                }),
            );

            // 11. Update comment with preview URLs (skip if no comment was created)
            if (feedbackEnabled && commentId !== "") {
                await this.provider.updateComment(
                    repoFullName,
                    commentId,
                    this.buildSuccessComment(prNumber, result, config),
                );
            }

            // 12. Set commit status to success
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
            if (tmpDir) {
                await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
            }
        }
    }

    private async cloneRepo(event: PullRequestEvent, targetDir: string): Promise<void> {
        // Pin the fetch to the exact head SHA, not the branch ref, so concurrent pushes
        // never race the extraction.
        await this.provider.fetchRepoTarball(event.repoFullName, event.headSha, targetDir);
    }

    private async buildAllApps(
        config: PreviewConfig,
        repoDir: string,
        repoFullName: string,
        prNumber: number,
        shortSha: string,
    ): Promise<Record<string, AppBuildResult>> {
        const [rawOrg, rawRepo] = repoFullName.split("/");
        const org = rawOrg!.toLowerCase();
        const repo = rawRepo!.toLowerCase();
        const appBuilds: Record<string, AppBuildResult> = {};

        for (const app of config.apps) {
            const registry = config.registry ?? this.registryUrl;
            const imageTag = `${registry}/${org}/${repo}:${app.name}-pr-${prNumber}-${shortSha}`;
            const contextPath = path.resolve(repoDir, app.path);

            const result = await this.builder.build({
                appName: app.name,
                contextPath,
                dockerfile: app.dockerfile,
                buildArgs: app.build_args,
                imageTag,
            });

            appBuilds[app.name] = { imageTag: result.imageTag, durationMs: result.durationMs };
        }

        return appBuilds;
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
            if (stdout) logger.debug("Post-deploy hook stdout", { app: hook.app, stdout });
            if (stderr) logger.debug("Post-deploy hook stderr", { app: hook.app, stderr });
        }
    }

    private buildPendingComment(prNumber: number): string {
        return [
            `## :previewkit: Preview Environment #${prNumber}`,
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
            `## :previewkit: Preview Environment #${prNumber}`,
            "",
            "**Status:** Ready",
            "",
            "| App | URL |",
            "|-----|-----|",
            urlLines,
            "",
            ...(serviceLines ? ["**Services:**", serviceLines, ""] : []),
            `**Namespace:** \`${result.namespace}\``,
        ].join("\n");
    }

    private buildFailureComment(prNumber: number, err: unknown): string {
        const message = err instanceof Error ? err.message : "Unknown error occurred";
        return [
            `## :previewkit: Preview Environment #${prNumber}`,
            "",
            "**Status:** Failed",
            "",
            "```",
            message,
            "```",
        ].join("\n");
    }
}

async function recordSafe(fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        logger.error("Failed to record Previewkit DB event", err);
    }
}
