/** Abstraction over GitHub's commit history for a repository branch. */
export interface GithubHistory {
    /** Returns the SHA of the latest commit on the branch after the given SHA, or undefined if up to date. */
    nextCommitOnBranch(afterSha: string): Promise<string | undefined>;

    /** Returns whichever of the two SHAs is the more recent commit on the branch. */
    latestBetween(sha1: string, sha2: string): Promise<string>;
}
