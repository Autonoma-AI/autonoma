import { type Logger, logger } from "@autonoma/logger";
import type { GitHubInstallationClient } from "../github-installation-client";
import type { GithubHistory } from "./github-history";

/** Real GithubHistory implementation backed by the GitHub REST API via Octokit. */
export class OctokitGithubHistory implements GithubHistory {
    private readonly logger: Logger;

    constructor(
        private readonly client: GitHubInstallationClient,
        private readonly owner: string,
        private readonly repo: string,
        private readonly branchRef: string,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async nextCommitOnBranch(afterSha: string): Promise<string | undefined> {
        this.logger.info("Querying next commit on branch", { branchRef: this.branchRef, afterSha });

        const commits = await this.client.listCommits(this.owner, this.repo, { sha: this.branchRef, perPage: 1 });
        const latestCommit = commits[0];

        if (latestCommit == null) {
            this.logger.info("No commits found on branch", {
                owner: this.owner,
                repo: this.repo,
                branchRef: this.branchRef,
            });
            return undefined;
        }

        if (latestCommit.sha === afterSha) return undefined;

        return latestCommit.sha;
    }

    async latestBetween(sha1: string, sha2: string): Promise<string> {
        this.logger.info("Comparing commits", { sha1, sha2 });

        if (sha1 === sha2) return sha1;

        const comparison = await this.client.compareCommits(this.owner, this.repo, sha2, sha1);

        // If sha1 is ahead of sha2 (or identical), sha1 is the latest
        if (comparison.aheadBy > 0) return sha1;

        return sha2;
    }
}
