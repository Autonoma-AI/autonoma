import type { GitHubCommentClient } from "@autonoma/github/comment";
import type { GitHubInstallationService } from "./github-installation.service";

export type GitHubCommentInstallationClient = Pick<
    GitHubInstallationService,
    "postComment" | "updateComment" | "deleteComment"
>;

/**
 * Adapts `GitHubInstallationService` (whose comment methods take a leading `organizationId`) to
 * the plain `GitHubCommentClient` shape `postOrUpdateCommentOnGithub` expects - binding one org so
 * the shared, dedup'd comment system can be used from `apps/api`, the same way `apps/previewkit`'s
 * `GitProvider` already implements the interface directly. Takes just the 3 comment methods
 * (matching the narrow `Pick<GitHubInstallationService, ...>` DI style already used elsewhere in
 * this app), not the full service.
 */
export function toGitHubCommentClient(
    githubInstallationService: GitHubCommentInstallationClient,
    organizationId: string,
): GitHubCommentClient {
    return {
        postComment: (repoFullName, prNumber, body) =>
            githubInstallationService.postComment(organizationId, repoFullName, prNumber, body),
        updateComment: (repoFullName, commentId, body) =>
            githubInstallationService.updateComment(organizationId, repoFullName, commentId, body),
        deleteComment: (repoFullName, commentId) =>
            githubInstallationService.deleteComment(organizationId, repoFullName, commentId),
    };
}
