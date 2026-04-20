import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Builder } from "../builder/builder";
import { loadPreviewConfig } from "../config/config-loader";
import type { PreviewConfig } from "../config/schema";
import type { Deployer } from "../deployer/deployer";
import { type DeployResult } from "../deployer/deployer";
import type { PullRequestEvent } from "../git-provider/git-provider";
import type { GitProvider } from "../git-provider/git-provider";
import { logger } from "../logger";
import type { SecretStore } from "../secrets/secret-store";

const execFileAsync = promisify(execFile);

interface PreviewPipelineOptions {
    provider: GitProvider;
    builder: Builder;
    deployer: Deployer;
    secretStore: SecretStore;
    registryUrl: string;
}

export class PreviewPipeline {
    private provider: GitProvider;
    private builder: Builder;
    private deployer: Deployer;
    private secretStore: SecretStore;
    private registryUrl: string;

    constructor(options: PreviewPipelineOptions) {
        this.provider = options.provider;
        this.builder = options.builder;
        this.deployer = options.deployer;
        this.secretStore = options.secretStore;
        this.registryUrl = options.registryUrl;
    }

    async deploy(event: PullRequestEvent): Promise<void> {
        const { repoFullName, prNumber, headSha } = event;
        const shortSha = headSha.slice(0, 7);

        logger.info("Starting preview deployment", { repo: repoFullName, pr: prNumber, sha: shortSha });

        // 1. Set commit status to pending
        await this.provider.setCommitStatus(repoFullName, headSha, "pending", "Building preview environment...");

        // 2. Post initial comment
        const commentId = await this.provider.postComment(repoFullName, prNumber, this.buildPendingComment(prNumber));

        // 3. Ensure namespace exists so status can be polled from the first moment
        await this.deployer.ensureNamespace(repoFullName, prNumber, {
            commentId,
            lastDeployedSha: headSha,
            status: "pending",
            phase: "initializing",
        });

        let tmpDir: string | undefined;

        try {
            // 4. Load config from repo
            await this.deployer.updateStatus(repoFullName, prNumber, {
                status: "pending",
                phase: "loading-config",
            });
            const config = await loadPreviewConfig(this.provider, repoFullName, headSha);

            // 5. Clone repo
            await this.deployer.updateStatus(repoFullName, prNumber, {
                status: "pending",
                phase: "cloning",
            });
            tmpDir = await mkdtemp(path.join(os.tmpdir(), `previewkit-${prNumber}-`));
            await this.cloneRepo(event, tmpDir);

            // 6. Load stored secrets per app (baseline owner+app merged with PR-scoped overrides)
            const owner = repoFullName.split("/")[0]!;
            const storedSecrets: Record<string, Record<string, string>> = {};
            for (const app of config.apps) {
                storedSecrets[app.name] = await this.secretStore.getMerged(owner, app.name, prNumber);
            }

            // 7. Build all app images
            await this.deployer.updateStatus(repoFullName, prNumber, {
                status: "building",
                phase: "building-images",
            });
            const imageTags = await this.buildAllApps(config, tmpDir, repoFullName, prNumber, shortSha);

            // 8. Deploy to Kubernetes
            await this.deployer.updateStatus(repoFullName, prNumber, {
                status: "deploying",
                phase: "deploying-k8s",
            });
            const result = await this.deployer.deploy({
                repoFullName,
                prNumber,
                headSha,
                config,
                imageTags,
                storedSecrets,
                commentId,
            });

            // 9. Run post-deploy hooks
            await this.deployer.updateStatus(repoFullName, prNumber, {
                status: "deploying",
                phase: "post-deploy-hooks",
            });
            await this.runPostDeployHooks(config, result);

            // 10. Mark ready + record URLs
            await this.deployer.updateStatus(repoFullName, prNumber, {
                status: "ready",
                phase: "ready",
                urls: result.urls,
            });

            // 11. Update comment with preview URLs
            await this.provider.updateComment(
                repoFullName,
                commentId,
                this.buildSuccessComment(prNumber, result, config),
            );

            // 12. Set commit status to success
            const firstUrl = Object.values(result.urls)[0];
            await this.provider.setCommitStatus(
                repoFullName,
                headSha,
                "success",
                "Preview environment ready",
                firstUrl,
            );

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

            await this.provider
                .updateComment(repoFullName, commentId, this.buildFailureComment(prNumber, err))
                .catch((e) => logger.error("Failed to update failure comment", e));

            await this.provider
                .setCommitStatus(repoFullName, headSha, "failure", "Preview deployment failed")
                .catch((e) => logger.error("Failed to set failure status", e));

            throw err;
        } finally {
            if (tmpDir) {
                await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
            }
        }
    }

    private async cloneRepo(event: PullRequestEvent, targetDir: string): Promise<void> {
        const { token } = await this.provider.getCloneCredentials(event.repoFullName);
        const cloneUrl = event.cloneUrl.replace("https://", `https://x-access-token:${token}@`);

        logger.info("Cloning repository", { repo: event.repoFullName, ref: event.headRef });

        await execFileAsync("git", ["clone", "--depth=1", "--branch", event.headRef, cloneUrl, targetDir]);
    }

    private async buildAllApps(
        config: PreviewConfig,
        repoDir: string,
        repoFullName: string,
        prNumber: number,
        shortSha: string,
    ): Promise<Record<string, string>> {
        const owner = repoFullName.split("/")[0]!;
        const imageTags: Record<string, string> = {};

        for (const app of config.apps) {
            const registry = config.registry ?? this.registryUrl;
            const imageTag = `${registry}/${owner}/${app.name}:pr-${prNumber}-${shortSha}`;
            const contextPath = path.resolve(repoDir, app.path);

            const result = await this.builder.build({
                appName: app.name,
                contextPath,
                dockerfile: app.dockerfile,
                buildArgs: app.build_args,
                imageTag,
            });

            imageTags[app.name] = result.imageTag;
        }

        return imageTags;
    }

    private async runPostDeployHooks(config: PreviewConfig, result: DeployResult): Promise<void> {
        if (config.hooks.post_deploy.length === 0) return;

        logger.info("Running post-deploy hooks", {
            namespace: result.namespace,
            hooks: config.hooks.post_deploy.length,
        });

        for (const hook of config.hooks.post_deploy) {
            logger.info("Executing post-deploy hook", { app: hook.app, command: hook.command });

            // kubectl exec into the first pod of the specified app
            await execFileAsync("kubectl", [
                "exec",
                "-n",
                result.namespace,
                `deployment/${hook.app}`,
                "--",
                "/bin/sh",
                "-c",
                hook.command,
            ]);
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
