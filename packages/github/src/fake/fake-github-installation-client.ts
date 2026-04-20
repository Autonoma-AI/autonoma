import type {
    CloneRepositoryParams,
    GitHubInstallationClient,
    PullRequest,
    Repository,
} from "../github-installation-client";

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
            baseSha,
            url: `https://github.com/${repoData.metadata.fullName}/pull/${pr.number}`,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
        };
    }

    async listPullRequests(repoId: number): Promise<PullRequest[]> {
        const repoData = this.requireRepoById(repoId);
        return await Promise.all(
            [...repoData.pullRequests.values()].map((pr) => this.getPullRequest(repoId, pr.number)),
        );
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
}
