import type { PreviewTeardownTarget } from "@autonoma/types";
import { recordEnvironmentTornDown } from "../db";
import type { Deployer } from "../deployer/deployer";
import type { GitProvider } from "../git-provider/git-provider";
import { logger, withObservabilityContext } from "../logger";

interface TeardownPipelineOptions {
    provider: GitProvider;
    deployer: Deployer;
}

export class TeardownPipeline {
    private readonly provider: GitProvider;
    private readonly deployer: Deployer;

    constructor(options: TeardownPipelineOptions) {
        this.provider = options.provider;
        this.deployer = options.deployer;
    }

    async teardown(target: PreviewTeardownTarget): Promise<void> {
        return await withObservabilityContext({ organization: { organizationId: target.organizationId } }, () =>
            this.runTeardown(target),
        );
    }

    private async runTeardown(target: PreviewTeardownTarget): Promise<void> {
        const { repoFullName, prNumber, headSha, organizationId } = target;

        logger.info("Starting preview teardown", { repo: repoFullName, pr: prNumber, headSha, organizationId });

        // Short-circuit if the namespace doesn't exist. This happens when the deploy
        // was silently skipped (no Application linked, or no preview config):
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

        logger.info("Step 1/3 deleting namespace (cascades to all resources)", {
            repo: repoFullName,
            pr: prNumber,
            namespace,
        });
        await this.deployer.teardown(repoFullName, prNumber);
        logger.info("Step 1/3 deleted namespace", { repo: repoFullName, pr: prNumber, namespace });

        // Best-effort: a failed DB write must never block teardown.
        logger.info("Step 2/3 recording teardown in DB", { repo: repoFullName, pr: prNumber, namespace });
        await recordEnvironmentTornDown(namespace).catch((err) => {
            logger.error("Failed to record Previewkit teardown", err, { namespace });
        });
        logger.info("Step 2/3 recorded teardown in DB", { repo: repoFullName, pr: prNumber, namespace });

        // No sha when the close webhook carried none and the environment row was already gone. There is no commit
        // to attach a status to, so say so rather than asking GitHub about the empty string.
        if (headSha == null) {
            logger.info("Step 3/3 skipped: no deployed commit to set a teardown status on", {
                repo: repoFullName,
                pr: prNumber,
            });
        } else {
            logger.info("Step 3/3 setting teardown commit status", { repo: repoFullName, pr: prNumber, headSha });
            await this.provider
                .setCommitStatus(repoFullName, headSha, "success", "Preview environment torn down")
                .catch((err) => logger.error("Failed to set teardown status", err));
            logger.info("Step 3/3 set teardown commit status", { repo: repoFullName, pr: prNumber, headSha });
        }

        logger.info("Preview teardown complete", { repo: repoFullName, pr: prNumber, namespace });
    }
}
