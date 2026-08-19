import type { PrismaClient } from "@autonoma/db";
import { createGitHubPrCommentStore, payloadBuilder, postOrUpdateCommentOnGithub } from "@autonoma/github/comment";
import { type GitHubCommentInstallationClient, toGitHubCommentClient } from "./github-comment-client.adapter";

/**
 * Posts (or updates in place) the one persistent "this org is out of credits" notice on a PR -
 * shared by both the previewkit-deploy gate and the PR-analysis gate, since either can be the
 * first to trip once an org is at/below its credit floor. Uses the shared dedup'd comment system
 * (`kind: "credits"`) instead of a raw one-shot post, so repeated blocked pushes update the same
 * comment rather than spamming a new one each time.
 *
 * `mode: "update"` (not "repost") - a persistent status notice, not an event log entry.
 * `staleGuard: "allow-new-head"` - "out of credits" isn't scoped to any one commit, so a later
 * push must still be able to find and update the existing notice rather than having it silently
 * dropped because the stored head sha moved on.
 */
export async function postInsufficientCreditsComment(
    githubInstallationService: GitHubCommentInstallationClient,
    db: PrismaClient,
    organizationId: string,
    repoFullName: string,
    prNumber: number,
    lastCommitSha: string,
): Promise<void> {
    await postOrUpdateCommentOnGithub({
        client: toGitHubCommentClient(githubInstallationService, organizationId),
        store: createGitHubPrCommentStore(db, "credits"),
        repoFullName,
        prNumber,
        lastCommitSha,
        staleGuard: "allow-new-head",
        mode: "update",
        payload: payloadBuilder({
            state: "critical",
            prNumber,
            message: "Insufficient credits",
            warnings: [
                "This organization is out of credits, so previewkit deploys and PR analysis are paused until credits are added.",
            ],
        }),
    });
}
