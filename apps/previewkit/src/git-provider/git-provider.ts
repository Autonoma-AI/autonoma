export interface PullRequestEvent {
    action: "opened" | "synchronize" | "closed" | "reopened";
    prNumber: number;
    repoFullName: string;
    headSha: string;
    headRef: string;
    baseSha: string;
    baseRef: string;
    cloneUrl: string;
}

export interface GitProvider {
    readonly name: string;

    fetchFileContent(repoFullName: string, path: string, ref: string): Promise<string | undefined>;

    getCloneCredentials(repoFullName: string): Promise<{ token: string }>;

    postComment(repoFullName: string, prNumber: number, body: string): Promise<string>;

    updateComment(repoFullName: string, commentId: string, body: string): Promise<void>;

    setCommitStatus(
        repoFullName: string,
        sha: string,
        state: "pending" | "success" | "failure" | "error",
        description: string,
        targetUrl?: string,
    ): Promise<void>;
}
