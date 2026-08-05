import { db } from "@autonoma/db";
import type { GitHubPrCommentKind } from "@autonoma/db";
import { createGitHubPrCommentStore, SEE_PREVIEW_CTA_LABEL, stripCtaFromBody } from "@autonoma/github/comment";
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

        logger.info("Step 1/6 reading namespace annotations", { repo: repoFullName, pr: prNumber, namespace });
        const annotations = await this.deployer.getNamespaceAnnotations(repoFullName, prNumber);
        logger.info("Step 1/6 read namespace annotations", {
            repo: repoFullName,
            pr: prNumber,
            namespace,
            hasCommentId: annotations?.commentId != null && annotations.commentId !== "",
        });

        logger.info("Step 2/6 deleting namespace (cascades to all resources)", {
            repo: repoFullName,
            pr: prNumber,
            namespace,
        });
        await this.deployer.teardown(repoFullName, prNumber);
        logger.info("Step 2/6 deleted namespace", { repo: repoFullName, pr: prNumber, namespace });

        // Best-effort: a failed DB write must never block teardown.
        logger.info("Step 3/6 recording teardown in DB", { repo: repoFullName, pr: prNumber, namespace });
        await recordEnvironmentTornDown(namespace).catch((err) => {
            logger.error("Failed to record Previewkit teardown", err, { namespace });
        });
        logger.info("Step 3/6 recorded teardown in DB", { repo: repoFullName, pr: prNumber, namespace });

        // The DB row is the source of truth (the comment is reposted with a new id on every
        // deploy); the namespace annotation is the fallback for pre-GitHubPrComment environments.
        const commentId = (await this.resolveCommentId(repoFullName, prNumber)) ?? annotations?.commentId;
        if (commentId != null && commentId !== "") {
            logger.info("Step 4/6 updating PR comment to torn-down state", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
                commentId,
            });
            await this.provider
                .updateComment(repoFullName, commentId, this.buildTeardownComment(prNumber))
                .catch((err) => logger.error("Failed to update teardown comment", err));
            logger.info("Step 4/6 updated PR comment", { repo: repoFullName, pr: prNumber, namespace });
        } else {
            logger.info("Step 4/6 no comment ID; skipping PR comment update", {
                repo: repoFullName,
                pr: prNumber,
                namespace,
            });
        }

        // The separate "investigation" comment (test results, posted by the investigation worker) carries its
        // own "See preview" button. Teardown never reposts it, so strip that now-dead link in place while
        // leaving the results intact. Best-effort: a failure here must not block teardown.
        logger.info("Step 5/6 stripping preview link from investigation comment", { repo: repoFullName, pr: prNumber });
        await this.stripPreviewLinkFromInvestigationComment(repoFullName, prNumber).catch((err) =>
            logger.error("Failed to strip preview link from investigation comment", err, {
                repo: repoFullName,
                pr: prNumber,
            }),
        );

        // No sha when the close webhook carried none and the environment row was already gone. There is no commit
        // to attach a status to, so say so rather than asking GitHub about the empty string.
        if (headSha == null) {
            logger.info("Step 6/6 skipped: no deployed commit to set a teardown status on", {
                repo: repoFullName,
                pr: prNumber,
            });
        } else {
            logger.info("Step 6/6 setting teardown commit status", { repo: repoFullName, pr: prNumber, headSha });
            await this.provider
                .setCommitStatus(repoFullName, headSha, "success", "Preview environment torn down")
                .catch((err) => logger.error("Failed to set teardown status", err));
            logger.info("Step 6/6 set teardown commit status", { repo: repoFullName, pr: prNumber, headSha });
        }

        logger.info("Preview teardown complete", { repo: repoFullName, pr: prNumber, namespace });
    }

    // Fetches the investigation comment, removes its "See preview" CTA, and re-posts the edited body. No-ops
    // (with a log) when there is no investigation comment, it is gone on GitHub, or it had no preview link.
    private async stripPreviewLinkFromInvestigationComment(repoFullName: string, prNumber: number): Promise<void> {
        const commentId = await this.resolveCommentId(repoFullName, prNumber, "investigation");
        if (commentId == null || commentId === "") {
            logger.info("No investigation comment; skipping preview-link strip", { repo: repoFullName, pr: prNumber });
            return;
        }

        const body = await this.provider.getComment(repoFullName, commentId);
        if (body == null) {
            logger.info("Investigation comment not found on GitHub; skipping preview-link strip", {
                repo: repoFullName,
                pr: prNumber,
                commentId,
            });
            return;
        }

        const stripped = stripCtaFromBody(body, SEE_PREVIEW_CTA_LABEL);
        if (stripped === body) {
            logger.info("Investigation comment has no preview link; nothing to strip", {
                repo: repoFullName,
                pr: prNumber,
                commentId,
            });
            return;
        }

        await this.provider.updateComment(repoFullName, commentId, stripped);
        logger.info("Stripped preview link from investigation comment", {
            repo: repoFullName,
            pr: prNumber,
            commentId,
        });
    }

    // Best-effort lookup of a PR comment id by kind; returns undefined on a missing row or DB
    // error so callers can degrade gracefully (the "preview" caller falls back to the namespace
    // annotation, the "investigation" caller simply skips) and teardown never fails on this read.
    private async resolveCommentId(
        repoFullName: string,
        prNumber: number,
        kind: GitHubPrCommentKind = "preview",
    ): Promise<string | undefined> {
        try {
            const state = await createGitHubPrCommentStore(db, kind).getState(repoFullName, prNumber);
            return state?.commentId ?? undefined;
        } catch (err) {
            logger.warn("Failed to read PR comment id from DB; falling back to namespace annotation", {
                repo: repoFullName,
                pr: prNumber,
                kind,
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
