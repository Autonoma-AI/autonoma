import { db } from "@autonoma/db";
import type { AddonManager } from "../addons/addon-manager";
import { recordEnvironmentTornDown } from "../db";
import type { Deployer } from "../deployer/deployer";
import type { PullRequestEvent } from "../git-provider/git-provider";
import type { GitProvider } from "../git-provider/git-provider";
import { logger, withObservabilityContext } from "../logger";

interface TeardownPipelineOptions {
    provider: GitProvider;
    deployer: Deployer;
    addonManager: AddonManager;
}

export class TeardownPipeline {
    private readonly provider: GitProvider;
    private readonly deployer: Deployer;
    private readonly addonManager: AddonManager;

    constructor(options: TeardownPipelineOptions) {
        this.provider = options.provider;
        this.deployer = options.deployer;
        this.addonManager = options.addonManager;
    }

    async teardown(event: PullRequestEvent): Promise<void> {
        return await withObservabilityContext({ organization: { organizationId: event.organizationId } }, () =>
            this.runTeardown(event),
        );
    }

    private async runTeardown(event: PullRequestEvent): Promise<void> {
        const { repoFullName, prNumber, headSha, organizationId } = event;

        logger.info("Starting preview teardown", { repo: repoFullName, pr: prNumber, headSha, organizationId });

        // Short-circuit if the namespace doesn't exist. This happens when the deploy
        // was silently skipped (no Application linked, or no active config revision):
        // there is nothing to tear down, no comment to update, no commit status to
        // flip. Acting anyway would 404 on a non-existent namespace.
        const namespace = this.deployer.getNamespaceName(repoFullName, prNumber);
        logger.info("Checking namespace existence", { repo: repoFullName, pr: prNumber, namespace });
        const exists = await this.deployer.namespaceExists(repoFullName, prNumber);
        if (!exists) {
            logger.info("Namespace does not exist; skipping teardown (deploy was previously a no-op)", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
            });
            return;
        }
        logger.info("Namespace exists; proceeding with teardown", { repo: repoFullName, pr: prNumber, namespace });

        logger.info("Step 1/6 reading namespace annotations", { repo: repoFullName, pr: prNumber, namespace });
        const annotations = await this.deployer.getNamespaceAnnotations(repoFullName, prNumber);
        logger.info("Step 1/6 read namespace annotations", {
            repo: repoFullName,
            pr: prNumber,
            namespace,
            hasCommentId: annotations?.commentId != null && annotations.commentId !== "",
        });

        // Deprovision third-party addons (Neon branches, etc.) before deleting the
        // namespace. Best-effort: orphaned external resources are recoverable via the
        // reconciler, but a stuck namespace is not, so per-addon failures must not
        // block the rest of teardown. The manager owns its own try/catch and the
        // persistence of failed states.
        logger.info("Step 2/6 looking up environment row for addon deprovisioning", {
            repo: repoFullName,
            pr: prNumber,
            namespace,
        });
        const envRow = await db.previewkitEnvironment
            .findUnique({ where: { namespace }, select: { id: true } })
            .catch((err: unknown) => {
                logger.warn("Failed to look up env row for addon deprovisioning; skipping", { namespace, err });
                return null;
            });
        if (envRow != null) {
            logger.info("Step 2/6 deprovisioning addons", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                environmentId: envRow.id,
            });
            await this.addonManager.deprovisionAll(envRow.id, organizationId).catch((err) => {
                logger.error("Addon deprovisioning encountered an unexpected error (continuing)", err, {
                    namespace,
                    organizationId,
                });
            });
            logger.info("Step 2/6 finished addon deprovisioning", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                environmentId: envRow.id,
            });
        } else {
            logger.info("Step 2/6 no environment row found; skipping addon deprovisioning", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
            });
        }

        logger.info("Step 3/6 deleting namespace (cascades to all resources)", {
            repo: repoFullName,
            pr: prNumber,
            namespace,
        });
        await this.deployer.teardown(repoFullName, prNumber);
        logger.info("Step 3/6 deleted namespace", { repo: repoFullName, pr: prNumber, namespace });

        // Best-effort: a failed DB write must never block teardown.
        logger.info("Step 4/6 recording teardown in DB", { repo: repoFullName, pr: prNumber, namespace });
        await recordEnvironmentTornDown(namespace).catch((err) => {
            logger.error("Failed to record Previewkit teardown", err, { namespace });
        });
        logger.info("Step 4/6 recorded teardown in DB", { repo: repoFullName, pr: prNumber, namespace });

        if (annotations?.commentId) {
            logger.info("Step 5/6 updating PR comment to torn-down state", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                commentId: annotations.commentId,
            });
            await this.provider
                .updateComment(repoFullName, annotations.commentId, this.buildTeardownComment(prNumber))
                .catch((err) => logger.error("Failed to update teardown comment", err));
            logger.info("Step 5/6 updated PR comment", { repo: repoFullName, pr: prNumber, namespace });
        } else {
            logger.info("Step 5/6 no comment ID; skipping PR comment update", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
            });
        }

        logger.info("Step 6/6 setting teardown commit status", { repo: repoFullName, pr: prNumber, headSha });
        await this.provider
            .setCommitStatus(repoFullName, headSha, "success", "Preview environment torn down")
            .catch((err) => logger.error("Failed to set teardown status", err));
        logger.info("Step 6/6 set teardown commit status", { repo: repoFullName, pr: prNumber, headSha });

        logger.info("Preview teardown complete", { repo: repoFullName, pr: prNumber, namespace });
    }

    private buildTeardownComment(prNumber: number): string {
        return [
            `## Preview Environment #${prNumber}`,
            "",
            "**Status:** Torn down",
            "",
            "This preview environment has been removed because the pull request was closed.",
        ].join("\n");
    }
}
