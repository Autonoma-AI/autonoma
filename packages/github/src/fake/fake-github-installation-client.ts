import type {
    CloneRepositoryParams,
    Commit,
    GitHubInstallationClient,
    PullRequest,
    PullRequestCommit,
    Repository,
} from "../github-installation-client";

export interface CommitDetails {
    message: string;
    authorLogin?: string;
}

export interface RepositorySetup {
    id: number;
    name: string;
    fullName: string;
    defaultBranch?: string;
    private?: boolean;
    /** Initial commits on the default branch, in chronological order (oldest first). */
    commits?: string[];
}

export interface PullRequestSetup {
    number: number;
    title: string;
    headRef: string;
    /** The commit SHA on the default branch where this PR forks from. */
    baseSha: string;
    /** Commits on the PR branch after the fork point, in chronological order (oldest first). */
    commits?: string[];
}

interface InternalBranch {
    /** Index into defaultBranchCommits where this branch forks (inclusive - the branch shares commits up to this index). */
    forkIndex: number;
    /** Additional commits on this branch after the fork point. */
    commits: string[];
}

interface InternalPullRequest {
    number: number;
    title: string;
    headRef: string;
}

interface InternalRepo {
    metadata: Repository;
    defaultBranchCommits: string[];
    branches: Map<string, InternalBranch>;
    pullRequests: Map<number, InternalPullRequest>;
    commitDetails: Map<string, CommitDetails>;
}

export class FakeGitHubInstallationClient implements GitHubInstallationClient {
    readonly createdIssues: Array<{
        repoId: number;
        title: string;
        body: string;
        labels?: string[];
    }> = [];

    private readonly repositories: Map<string, InternalRepo> = new Map();
    private readonly repoById: Map<number, InternalRepo> = new Map();

    addRepository(setup: RepositorySetup): void {
        const metadata: Repository = {
            id: setup.id,
            name: setup.name,
            fullName: setup.fullName,
            defaultBranch: setup.defaultBranch ?? "main",
            private: setup.private ?? false,
        };
        const repo: InternalRepo = {
            metadata,
            defaultBranchCommits: setup.commits ?? [],
            branches: new Map(),
            pullRequests: new Map(),
            commitDetails: new Map(),
        };
        this.repositories.set(setup.fullName, repo);
        this.repoById.set(setup.id, repo);
    }

    addPullRequest(fullName: string, setup: PullRequestSetup): void {
        const repo = this.requireRepo(fullName);
        const forkIndex = repo.defaultBranchCommits.indexOf(setup.baseSha);
        if (forkIndex === -1) {
            throw new Error(
                `baseSha "${setup.baseSha}" not found on default branch of ${fullName}. ` +
                    `Available commits: [${repo.defaultBranchCommits.join(", ")}]`,
            );
        }

        repo.branches.set(setup.headRef, {
            forkIndex,
            commits: setup.commits ?? [],
        });

        repo.pullRequests.set(setup.number, {
            number: setup.number,
            title: setup.title,
            headRef: setup.headRef,
        });
    }

    /** Registers metadata (commit message, author) for a SHA. The SHA must already exist on some branch. */
    setCommitDetails(fullName: string, sha: string, details: CommitDetails): void {
        const repo = this.requireRepo(fullName);
        if (!this.shaExistsInRepo(repo, sha)) {
            throw new Error(`Commit "${sha}" not found on any branch of ${fullName}`);
        }
        repo.commitDetails.set(sha, details);
    }

    /** Appends a commit to a branch. For the default branch, pass its name (e.g. "main"). */
    pushCommit(fullName: string, branch: string, sha: string): void {
        const repo = this.requireRepo(fullName);
        if (branch === repo.metadata.defaultBranch) {
            repo.defaultBranchCommits.push(sha);
        } else {
            const branchData = repo.branches.get(branch);
            if (branchData == null) throw new Error(`Branch "${branch}" not found in ${fullName}`);
            branchData.commits.push(sha);
        }
    }

    async getRepository(repoId: number): Promise<Repository> {
        const repo = this.repoById.get(repoId);
        if (repo == null) throw new Error(`Repository ${repoId} not found`);
        return repo.metadata;
    }

    async listInstallationRepos(): Promise<Repository[]> {
        return [...this.repositories.values()].map((r) => r.metadata);
    }

    async getRepositoryArchiveUrl(repoId: number, ref = "HEAD"): Promise<string> {
        const repo = await this.getRepository(repoId);
        return `https://example.test/${repo.fullName}/tarball/${ref}`;
    }

    async getPullRequest(repoId: number, prNumber: number): Promise<PullRequest> {
        const repoData = this.requireRepoById(repoId);
        const pr = repoData.pullRequests.get(prNumber);
        if (pr == null) throw new Error(`Pull request ${repoData.metadata.fullName}#${prNumber} not found`);

        const branch = repoData.branches.get(pr.headRef);
        if (branch == null) throw new Error(`Branch "${pr.headRef}" not found for PR #${prNumber}`);

        const headSha = this.latestCommitOnBranch(repoData, branch);
        const baseSha = repoData.defaultBranchCommits.at(-1);
        if (headSha == null) throw new Error(`No commits on branch "${pr.headRef}"`);
        if (baseSha == null) throw new Error(`No commits on default branch of ${repoData.metadata.fullName}`);

        return {
            number: pr.number,
            title: pr.title,
            headRef: pr.headRef,
            headSha,
            baseRef: repoData.metadata.defaultBranch,
            baseSha,
            url: `https://github.com/${repoData.metadata.fullName}/pull/${pr.number}`,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            state: "open",
            commitsCount: branch.commits.length,
            merged: false,
        };
    }

    async listPullRequests(repoId: number): Promise<PullRequest[]> {
        const repoData = this.requireRepoById(repoId);
        return await Promise.all(
            [...repoData.pullRequests.values()].map((pr) => this.getPullRequest(repoId, pr.number)),
        );
    }

    async getAssociatedPullRequests(owner: string, repo: string, sha: string): Promise<PullRequest[]> {
        const fullName = `${owner}/${repo}`;
        const repoData = this.requireRepo(fullName);
        const associated: PullRequest[] = [];
        for (const pr of repoData.pullRequests.values()) {
            const branch = repoData.branches.get(pr.headRef);
            if (branch == null) continue;
            if (branch.commits.includes(sha)) {
                associated.push(await this.getPullRequest(repoData.metadata.id, pr.number));
            }
        }
        return associated;
    }

    async listPullRequestCommits(repoId: number, prNumber: number): Promise<PullRequestCommit[]> {
        const repo = this.requireRepoById(repoId);
        const pr = repo.pullRequests.get(prNumber);
        if (pr == null) throw new Error(`Pull request ${repo.metadata.fullName}#${prNumber} not found`);

        const branch = repo.branches.get(pr.headRef);
        if (branch == null) throw new Error(`Branch "${pr.headRef}" not found for PR #${prNumber}`);

        return branch.commits.map((sha) => {
            const details = repo.commitDetails.get(sha);
            return {
                sha,
                message: details?.message ?? "",
                authorLogin: details?.authorLogin,
                authoredAt: "2026-01-01T00:00:00Z",
            };
        });
    }

    async getCommit(repoId: number, sha: string): Promise<Commit> {
        const repo = this.requireRepoById(repoId);
        if (!this.shaExistsInRepo(repo, sha)) {
            throw new Error(`Commit "${sha}" not found in ${repo.metadata.fullName}`);
        }
        const details = repo.commitDetails.get(sha);
        return {
            sha,
            message: details?.message ?? "",
            authorLogin: details?.authorLogin,
        };
    }

    async getBranchHead(repoId: number, branchName: string): Promise<string> {
        const repoData = this.requireRepoById(repoId);
        if (branchName === repoData.metadata.defaultBranch) {
            const head = repoData.defaultBranchCommits.at(-1);
            if (head == null) {
                throw new Error(`No commits on default branch of ${repoData.metadata.fullName}`);
            }
            return head;
        }

        const branch = repoData.branches.get(branchName);
        if (branch == null) {
            throw new Error(`Branch "${branchName}" not found in ${repoData.metadata.fullName}`);
        }
        const head = this.latestCommitOnBranch(repoData, branch);
        if (head == null) {
            throw new Error(`No commits on branch "${branchName}"`);
        }
        return head;
    }

    async getInstallation(_installationId: number): Promise<{ account: unknown }> {
        throw new Error("FakeGitHubInstallationClient.getInstallation is not implemented");
    }

    async getInstallationToken(): Promise<string> {
        throw new Error("FakeGitHubInstallationClient.getInstallationToken is not implemented");
    }

    async cloneRepository(_params: CloneRepositoryParams): Promise<string> {
        throw new Error("FakeGitHubInstallationClient.cloneRepository is not implemented");
    }

    private requireRepo(fullName: string): InternalRepo {
        const repo = this.repositories.get(fullName);
        if (repo == null) throw new Error(`Repository ${fullName} not found`);
        return repo;
    }

    private requireRepoById(repoId: number): InternalRepo {
        const repo = this.repoById.get(repoId);
        if (repo == null) throw new Error(`Repository with ID ${repoId} not found`);
        return repo;
    }

    private latestCommitOnBranch(repo: InternalRepo, branch: InternalBranch): string | undefined {
        return branch.commits.at(-1) ?? repo.defaultBranchCommits[branch.forkIndex];
    }

    private shaExistsInRepo(repo: InternalRepo, sha: string): boolean {
        if (repo.defaultBranchCommits.includes(sha)) return true;
        for (const branch of repo.branches.values()) {
            if (branch.commits.includes(sha)) return true;
        }
        return false;
    }
}
