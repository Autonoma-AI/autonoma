import { isGithubFeedbackEnabledForNamespace, recordEnvironmentTornDown } from "../db";
import type { Deployer } from "../deployer/deployer";
import type { PullRequestEvent } from "../git-provider/git-provider";
import type { GitProvider } from "../git-provider/git-provider";
import { logger } from "../logger";

interface TeardownPipelineOptions {
    provider: GitProvider;
    deployer: Deployer;
}

export class TeardownPipeline {
    private provider: GitProvider;
    private deployer: Deployer;

    constructor(options: TeardownPipelineOptions) {
        this.provider = options.provider;
        this.deployer = options.deployer;
    }

    async teardown(event: PullRequestEvent): Promise<void> {
        const { repoFullName, prNumber, headSha } = event;

        logger.info("Starting preview teardown", { repo: repoFullName, pr: prNumber });

        // 0. Short-circuit if the namespace doesn't exist. This happens when
        //    the deploy was silently skipped (no Application linked, or no
        //    `.preview.yaml` at the head SHA) — there's nothing to tear down,
        //    no comment to update, no commit status to flip. Acting anyway
        //    would try to delete a non-existent namespace and surface a 404.
        const namespace = this.deployer.getNamespaceName(repoFullName, prNumber);
        const exists = await this.deployer.namespaceExists(repoFullName, prNumber);
        if (!exists) {
            logger.info("Namespace does not exist; skipping teardown (deploy was previously a no-op)", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
            });
            return;
        }

        // 1. Resolve per-org feedback flag before deleting the namespace —
        //    we look it up from the environment row, which goes away on teardown.
        const feedbackEnabled = await isGithubFeedbackEnabledForNamespace(namespace);
        if (!feedbackEnabled) {
            logger.info("GitHub feedback disabled for this environment; skipping teardown feedback", { namespace });
        }

        // 1. Read namespace annotations to find the comment ID
        const annotations = await this.deployer.getNamespaceAnnotations(repoFullName, prNumber);

        // 2. Delete the namespace (cascading delete of all resources)
        await this.deployer.teardown(repoFullName, prNumber);

        // 2b. Record teardown in the DB (best-effort; never blocks teardown).
        await recordEnvironmentTornDown(namespace).catch((err) => {
            logger.error("Failed to record Previewkit teardown", err, { namespace });
        });

        // 4. Update the PR comment if we have a comment ID
        if (feedbackEnabled && annotations?.commentId) {
            await this.provider
                .updateComment(repoFullName, annotations.commentId, this.buildTeardownComment(prNumber))
                .catch((err) => logger.error("Failed to update teardown comment", err));
        }

        // 5. Set commit status
        if (feedbackEnabled) {
            await this.provider
                .setCommitStatus(repoFullName, headSha, "success", "Preview environment torn down")
                .catch((err) => logger.error("Failed to set teardown status", err));
        }

        logger.info("Preview teardown complete", { repo: repoFullName, pr: prNumber });
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
