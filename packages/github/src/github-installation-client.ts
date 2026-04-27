import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Logger, logger } from "@autonoma/logger";
import type { App } from "@octokit/app";

const execFileAsync = promisify(execFile);

type InstallationOctokit = Awaited<ReturnType<App["getInstallationOctokit"]>>;

export interface Repository {
    id: number;
    name: string;
    fullName: string;
    defaultBranch: string;
    private: boolean;
}

export interface Commit {
    sha: string;
    message: string;
    authorLogin?: string;
}

export interface PullRequest {
    number: number;
    title: string;
    headRef: string;
    headSha: string;
    baseRef: string;
    baseSha: string;
    url: string;
    authorLogin?: string;
    createdAt: string;
    updatedAt: string;
    merged: boolean;
    mergedAt?: string;
    mergeMethod?: "merge" | "squash" | "rebase";
    mergeCommitSha?: string;
}

export interface CloneRepositoryParams {
    fullName: string;
    headSha: string;
    baseSha?: string;
    targetDir: string;
    depth?: number;
}

export interface GitHubInstallationClient {
    getInstallation(installationId: number): Promise<{ account: unknown }>;
    getInstallationToken(): Promise<string>;
    cloneRepository(params: CloneRepositoryParams): Promise<string>;
    getRepository(repoId: number): Promise<Repository>;
    listInstallationRepos(): Promise<Repository[]>;
    getPullRequest(repoId: number, prNumber: number): Promise<PullRequest>;
    listPullRequests(repoId: number): Promise<PullRequest[]>;
    getAssociatedPullRequests(owner: string, repo: string, sha: string): Promise<PullRequest[]>;
    getCommit(repoId: number, sha: string): Promise<Commit>;
    getBranchHead(repoId: number, branchName: string): Promise<string>;
}

interface RawPullRequestLike {
    number: number;
    title: string;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    html_url: string;
    user: { login: string } | null;
    created_at: string;
    updated_at: string;
    merged?: boolean;
    merged_at: string | null;
    merge_commit_sha: string | null;
}

function mapPullRequest(pr: RawPullRequestLike): PullRequest {
    const merged = pr.merged ?? pr.merged_at != null;
    return {
        number: pr.number,
        title: pr.title,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        url: pr.html_url,
        authorLogin: pr.user?.login,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        merged,
        mergedAt: pr.merged_at ?? undefined,
        mergeCommitSha: pr.merge_commit_sha ?? undefined,
    };
}

/** Typed wrapper around an installation-scoped Octokit. */
export class OctokitGitHubInstallationClient implements GitHubInstallationClient {
    private readonly logger: Logger;

    constructor(private readonly octokit: InstallationOctokit) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async getInstallation(installationId: number): Promise<{ account: unknown }> {
        this.logger.info("Fetching installation details", { installationId });

        const { data } = await this.octokit.request("GET /app/installations/{installation_id}", {
            installation_id: installationId,
        });

        this.logger.info("Fetched installation details", { installationId });

        return { account: data.account };
    }

    async getInstallationToken(): Promise<string> {
        this.logger.info("Resolving installation token");
        const { token } = (await this.octokit.auth({ type: "installation" })) as { token: string };
        this.logger.info("Resolved installation token");
        return token;
    }

    /**
     * Clones a repository using the installation token, checks out headSha,
     * and optionally fetches baseSha for diff comparison.
     */
    async cloneRepository(params: CloneRepositoryParams): Promise<string> {
        const { fullName, headSha, baseSha, targetDir, depth = 50 } = params;

        this.logger.info("Resolving installation token for clone", { fullName });
        const token = await this.getInstallationToken();

        const cloneUrl = `https://x-access-token:${token}@github.com/${fullName}.git`;

        this.logger.info("Cloning repository", { fullName, headSha, targetDir });
        await execFileAsync("git", ["clone", `--depth=${depth}`, cloneUrl, targetDir], {
            maxBuffer: 10 * 1024 * 1024,
            timeout: 120_000,
        });

        this.logger.info("Checking out commit", { headSha });
        try {
            await execFileAsync("git", ["checkout", headSha], { cwd: targetDir });
        } catch {
            this.logger.info("Head SHA not in shallow clone, fetching explicitly", { headSha });
            await execFileAsync("git", ["fetch", `--depth=${depth}`, "origin", headSha], {
                cwd: targetDir,
                timeout: 60_000,
            });
            await execFileAsync("git", ["checkout", headSha], { cwd: targetDir });
        }

        if (baseSha != null) {
            this.logger.info("Ensuring base commit is available", { baseSha });
            try {
                await execFileAsync("git", ["cat-file", "-t", baseSha], { cwd: targetDir });
            } catch {
                await execFileAsync("git", ["fetch", `--depth=${depth}`, "origin", baseSha], {
                    cwd: targetDir,
                    timeout: 60_000,
                });
            }
        }

        this.logger.info("Repository cloned successfully", { fullName, targetDir });
        return targetDir;
    }

    async getRepository(repoId: number): Promise<Repository> {
        this.logger.info("Fetching repository by ID", { repoId });

        const { data } = await this.octokit.request("GET /repositories/{repository_id}", {
            repository_id: repoId,
        });

        const repo = {
            id: data.id,
            name: data.name,
            fullName: data.full_name,
            defaultBranch: data.default_branch,
            private: data.private,
        };

        this.logger.info("Fetched repository", { repoId, fullName: repo.fullName });

        return repo;
    }

    async listInstallationRepos(): Promise<Repository[]> {
        this.logger.info("Listing installation repositories");

        const response = await this.octokit.request("GET /installation/repositories", { per_page: 100 });

        const repos = response.data.repositories.map((r) => ({
            id: r.id,
            name: r.name,
            fullName: r.full_name,
            defaultBranch: r.default_branch,
            private: r.private,
        }));

        this.logger.info("Listed installation repositories", { count: repos.length });

        return repos;
    }

    async getPullRequest(repoId: number, prNumber: number): Promise<PullRequest> {
        const { owner, repo } = await this.resolveOwnerRepo(repoId);
        this.logger.info("Fetching pull request", { repoId, prNumber });

        const { data: pr } = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
            owner,
            repo,
            pull_number: prNumber,
        });

        const pullRequest = mapPullRequest(pr);

        this.logger.info("Fetched pull request", { repoId, prNumber, headRef: pullRequest.headRef });

        return pullRequest;
    }

    async listPullRequests(repoId: number): Promise<PullRequest[]> {
        const { owner, repo } = await this.resolveOwnerRepo(repoId);
        this.logger.info("Listing open pull requests", { repoId });

        const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/pulls", {
            owner,
            repo,
            state: "open",
            per_page: 50,
        });

        const pullRequests = data.map((pr) => mapPullRequest(pr));

        this.logger.info("Listed pull requests", { repoId, count: pullRequests.length });

        return pullRequests;
    }

    async getAssociatedPullRequests(owner: string, repo: string, sha: string): Promise<PullRequest[]> {
        this.logger.info("Fetching pull requests associated with commit", { owner, repo, sha });

        const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", {
            owner,
            repo,
            commit_sha: sha,
            per_page: 100,
        });

        const pullRequests = data.map((pr) => mapPullRequest(pr));

        this.logger.info("Fetched pull requests associated with commit", {
            owner,
            repo,
            sha,
            count: pullRequests.length,
        });

        return pullRequests;
    }

    async getCommit(repoId: number, sha: string): Promise<Commit> {
        const { owner, repo } = await this.resolveOwnerRepo(repoId);
        this.logger.info("Fetching commit", { repoId, sha });

        const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
            owner,
            repo,
            ref: sha,
        });

        const commit: Commit = {
            sha: data.sha,
            message: data.commit.message,
            authorLogin: data.author?.login,
        };

        this.logger.info("Fetched commit", { repoId, sha: commit.sha });

        return commit;
    }

    async getBranchHead(repoId: number, branchName: string): Promise<string> {
        const { owner, repo } = await this.resolveOwnerRepo(repoId);
        this.logger.info("Fetching branch head", { repoId, branchName });

        const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
            owner,
            repo,
            branch: branchName,
        });

        const sha = data.commit.sha;
        this.logger.info("Fetched branch head", { repoId, branchName, sha });
        return sha;
    }

    private async resolveOwnerRepo(repoId: number): Promise<{ owner: string; repo: string }> {
        const repository = await this.getRepository(repoId);
        const [owner, repo] = repository.fullName.split("/");
        if (owner == null || repo == null) {
            throw new Error(`Invalid repository fullName format: ${repository.fullName}`);
        }
        return { owner, repo };
    }
}
