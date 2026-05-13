import { isGithubFeedbackEnabledForNamespace, recordEnvironmentTornDown } from "../db";
import type { Deployer } from "../deployer/deployer";
import type { PullRequestEvent } from "../git-provider/git-provider";
import type { GitProvider } from "../git-provider/git-provider";
import { logger } from "../logger";
import type { SecretStore } from "../secrets/secret-store";

interface TeardownPipelineOptions {
    provider: GitProvider;
    deployer: Deployer;
    secretStore: SecretStore;
}

export class TeardownPipeline {
    private provider: GitProvider;
    private deployer: Deployer;
    private secretStore: SecretStore;

    constructor(options: TeardownPipelineOptions) {
        this.provider = options.provider;
        this.deployer = options.deployer;
        this.secretStore = options.secretStore;
    }

    async teardown(event: PullRequestEvent): Promise<void> {
        const { repoFullName, prNumber, headSha } = event;

        logger.info("Starting preview teardown", { repo: repoFullName, pr: prNumber });

        // 0. Resolve per-org feedback flag before deleting the namespace —
        //    we look it up from the environment row, which goes away on teardown.
        const namespace = this.deployer.getNamespaceName(repoFullName, prNumber);
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

        // 3. Delete PR-scoped secrets across all apps for this owner
        const owner = repoFullName.split("/")[0]!;
        await this.secretStore
            .deleteAllForPr(owner, prNumber)
            .catch((err) => logger.error("Failed to delete PR-scoped secrets", err));

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
            `## :previewkit: Preview Environment #${prNumber}`,
            "",
            "**Status:** Torn down",
            "",
            "This preview environment has been removed because the pull request was closed.",
        ].join("\n");
    }
}
