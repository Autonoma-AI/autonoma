export interface PullRequestEvent {
    action: "opened" | "synchronize" | "closed" | "reopened";
    prNumber: number;
    repoFullName: string;
    // Resolved by the upstream API from the installation that fired the webhook.
    // Required on every action — teardown carries it for logging/auditing even
    // though the actual cleanup is namespace-scoped.
    organizationId: string;
    // The GitHub-side numeric repo id (`repository.id` from the webhook).
    // Used to join into Application via the (organizationId, githubRepositoryId) unique.
    githubRepositoryId: number;
    headSha: string;
    headRef: string;
    baseSha: string;
    baseRef: string;
    cloneUrl: string;
}

export interface GitRepository {
    id: number;
    name: string;
    fullName: string;
    defaultBranch: string;
    private: boolean;
}

export interface GitProvider {
    readonly name: string;

    getRepository(installationId: number, repositoryId: number): Promise<GitRepository>;

    /**
     * Resolves a repository by its `owner/name` full name through the installation
     * that has access to it. Returns undefined when the repo doesn't exist or no
     * installation can see it - callers use this to map config repo references
     * (e.g. multirepo dependencies) onto GitHub-side repo ids.
     */
    getRepositoryByFullName(repoFullName: string): Promise<GitRepository | undefined>;

    getBranchHead(repoFullName: string, branchName: string): Promise<string>;

    fetchFileContent(repoFullName: string, path: string, ref: string): Promise<string | undefined>;

    /**
     * Download the repository at `ref` as a gzipped tarball and extract its contents into
     * `targetDir`. Implementations must strip the archive's top-level directory so files
     * land directly under `targetDir`.
     */
    fetchRepoTarball(repoFullName: string, ref: string, targetDir: string): Promise<void>;

    postComment(repoFullName: string, prNumber: number, body: string): Promise<string>;

    updateComment(repoFullName: string, commentId: string, body: string): Promise<void>;

    setCommitStatus(
        repoFullName: string,
        sha: string,
        state: "pending" | "success" | "failure" | "error",
        description: string,
        targetUrl?: string,
    ): Promise<void>;

    createDeployment(
        repoFullName: string,
        ref: string,
        environment: string,
        payload: Record<string, string>,
    ): Promise<number>;

    createDeploymentStatus(
        repoFullName: string,
        deploymentId: number,
        state: "success" | "failure" | "in_progress" | "error",
        targetUrl?: string,
        description?: string,
    ): Promise<void>;
}
