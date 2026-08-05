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

    /**
     * Download the repository at `ref` as a gzipped tarball and extract its contents into
     * `targetDir`. Implementations must strip the archive's top-level directory so files
     * land directly under `targetDir`.
     */
    fetchRepoTarball(repoFullName: string, ref: string, targetDir: string): Promise<void>;

    postComment(repoFullName: string, prNumber: number, body: string): Promise<string>;

    /**
     * Fetch a PR comment's raw markdown body. Resolves to `undefined` when the comment no longer
     * exists (GitHub 404) so callers can skip a best-effort edit rather than fail.
     */

    updateComment(repoFullName: string, commentId: string, body: string): Promise<void>;

    /**
     * Delete a PR comment. Must be idempotent: deleting an already-deleted comment
     * (GitHub 404) resolves rather than throws.
     */
    deleteComment(repoFullName: string, commentId: string): Promise<void>;

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
