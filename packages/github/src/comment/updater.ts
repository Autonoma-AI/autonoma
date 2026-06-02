import { logger as rootLogger } from "@autonoma/logger";
import { renderMarkdown } from "./markdown";
import type { PostOrUpdateCommentInput, PostOrUpdateCommentResult } from "./types";

export async function postOrUpdateCommentOnGithub(input: PostOrUpdateCommentInput): Promise<PostOrUpdateCommentResult> {
    const logger = rootLogger.child({ name: "postOrUpdateCommentOnGithub" });
    const stored = await input.store.getState(input.repoFullName, input.prNumber);

    if (input.staleGuard !== "allow-new-head" && stored?.headSha != null && stored.headSha !== input.lastCommitSha) {
        logger.info("Skipping stale PR comment update", {
            repoFullName: input.repoFullName,
            prNumber: input.prNumber,
            storedHeadSha: stored.headSha,
            incomingHeadSha: input.lastCommitSha,
        });
        return { status: "stale_skipped", storedHeadSha: stored.headSha, incomingHeadSha: input.lastCommitSha };
    }

    const body = renderMarkdown(input.payload);
    const existingCommentId = input.commentId ?? stored?.commentId ?? null;

    if (existingCommentId != null && existingCommentId !== "") {
        try {
            await input.client.updateComment(input.repoFullName, existingCommentId, body);
            await input.store.setCommentId(input.repoFullName, input.prNumber, existingCommentId);
            logger.info("Updated PR comment", {
                repoFullName: input.repoFullName,
                prNumber: input.prNumber,
                commentId: existingCommentId,
            });
            return { status: "updated", commentId: existingCommentId, body };
        } catch (err) {
            // The stored comment was likely deleted on GitHub (or we lost permissions).
            // Fall through and post a fresh one, overwriting the stale stored id below.
            logger.warn("Failed to update existing PR comment; posting a fresh one", {
                repoFullName: input.repoFullName,
                prNumber: input.prNumber,
                commentId: existingCommentId,
                err,
            });
        }
    }

    const postedCommentId = await input.client.postComment(input.repoFullName, input.prNumber, body);
    await input.store.setCommentId(input.repoFullName, input.prNumber, postedCommentId);
    logger.info("Posted PR comment", {
        repoFullName: input.repoFullName,
        prNumber: input.prNumber,
        commentId: postedCommentId,
    });
    return { status: "posted", commentId: postedCommentId, body };
}
