import { db } from "@autonoma/db";
import { createGitHubPrCommentStore } from "@autonoma/github/comment";
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

        logger.info("Step 1/5 reading namespace annotations", { repo: repoFullName, pr: prNumber, namespace });
        const annotations = await this.deployer.getNamespaceAnnotations(repoFullName, prNumber);
        logger.info("Step 1/5 read namespace annotations", {
            repo: repoFullName,
            pr: prNumber,
            namespace,
            hasCommentId: annotations?.commentId != null && annotations.commentId !== "",
        });

        logger.info("Step 2/5 deleting namespace (cascades to all resources)", {
            repo: repoFullName,
            pr: prNumber,
            namespace,
        });
        await this.deployer.teardown(repoFullName, prNumber);
        logger.info("Step 2/5 deleted namespace", { repo: repoFullName, pr: prNumber, namespace });

        // Best-effort: a failed DB write must never block teardown.
        logger.info("Step 3/5 recording teardown in DB", { repo: repoFullName, pr: prNumber, namespace });
        await recordEnvironmentTornDown(namespace).catch((err) => {
            logger.error("Failed to record Previewkit teardown", err, { namespace });
        });
        logger.info("Step 3/5 recorded teardown in DB", { repo: repoFullName, pr: prNumber, namespace });

        // The DB row is the source of truth (the comment is reposted with a new id on every
        // deploy); the namespace annotation is the fallback for pre-GitHubPrComment environments.
        const commentId = (await this.resolveCommentId(repoFullName, prNumber)) ?? annotations?.commentId;
        if (commentId != null && commentId !== "") {
            logger.info("Step 4/5 updating PR comment to torn-down state", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                commentId,
            });
            await this.provider
                .updateComment(repoFullName, commentId, this.buildTeardownComment(prNumber))
                .catch((err) => logger.error("Failed to update teardown comment", err));
            logger.info("Step 4/5 updated PR comment", { repo: repoFullName, pr: prNumber, namespace });
        } else {
            logger.info("Step 4/5 no comment ID; skipping PR comment update", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
            });
        }

        // No sha when the close webhook carried none and the environment row was already gone. There is no commit
        // to attach a status to, so say so rather than asking GitHub about the empty string.
        if (headSha == null) {
            logger.info("Step 5/5 skipped: no deployed commit to set a teardown status on", {
                repo: repoFullName,
                pr: prNumber,
            });
        } else {
            logger.info("Step 5/5 setting teardown commit status", { repo: repoFullName, pr: prNumber, headSha });
            await this.provider
                .setCommitStatus(repoFullName, headSha, "success", "Preview environment torn down")
                .catch((err) => logger.error("Failed to set teardown status", err));
            logger.info("Step 5/5 set teardown commit status", { repo: repoFullName, pr: prNumber, headSha });
        }

        logger.info("Preview teardown complete", { repo: repoFullName, pr: prNumber, namespace });
    }

    // Best-effort lookup of the preview PR comment's id; returns undefined on a missing row or DB error so the
    // caller can degrade gracefully (falling back to the namespace annotation) and teardown never fails on it.
    private async resolveCommentId(repoFullName: string, prNumber: number): Promise<string | undefined> {
        try {
            const state = await createGitHubPrCommentStore(db, "preview").getState(repoFullName, prNumber);
            return state?.commentId ?? undefined;
        } catch (err) {
            logger.warn("Failed to read PR comment id from DB; falling back to namespace annotation", {
                repo: repoFullName,
                pr: prNumber,
                err,
            });
            return undefined;
        }
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
