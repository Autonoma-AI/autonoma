import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Logger, logger } from "@autonoma/logger";
import type { App } from "@octokit/app";

const execFileAsync = promisify(execFile);
const GITHUB_API = "https://api.github.com";

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

export type PullRequestState = "open" | "closed" | "merged";

export interface PullRequest {
    number: number;
    title: string;
    body?: string;
    headRef: string;
    headSha: string;
    baseRef: string;
    baseSha: string;
    url: string;
    authorLogin?: string;
    createdAt: string;
    updatedAt: string;
    state: PullRequestState;
    commitsCount: number;
    merged: boolean;
    mergedAt?: string;
    mergeMethod?: "merge" | "squash" | "rebase";
    mergeCommitSha?: string;
}

export interface PullRequestCommit {
    sha: string;
    message: string;
    authorLogin?: string;
    authoredAt: string;
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
    getRepositoryArchiveUrl(repoId: number, ref?: string): Promise<string>;
    listInstallationRepos(): Promise<Repository[]>;
    getPullRequest(repoId: number, prNumber: number): Promise<PullRequest>;
    listPullRequests(repoId: number): Promise<PullRequest[]>;
    getAssociatedPullRequests(owner: string, repo: string, sha: string): Promise<PullRequest[]>;
    listPullRequestCommits(repoId: number, prNumber: number): Promise<PullRequestCommit[]>;
    getCommit(repoId: number, sha: string): Promise<Commit>;
    getBranchHead(repoId: number, branchName: string): Promise<string>;
    postComment(repoFullName: string, prNumber: number, body: string): Promise<string>;
    updateComment(repoFullName: string, commentId: string, body: string): Promise<void>;
}

interface RawPullRequestLike {
    number: number;
    title: string;
    body?: string | null;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    html_url: string;
    user: { login: string } | null;
    created_at: string;
    updated_at: string;
    state?: string;
    commits?: number;
    merged?: boolean;
    merged_at: string | null;
    merge_commit_sha: string | null;
}

export function parseRepoFullName(repoFullName: string): { owner: string; repo: string } {
    const parts = repoFullName.split("/");
    if (parts.length !== 2) {
        throw new Error(`Invalid repository fullName format: ${repoFullName}`);
    }
    const owner = parts[0];
    const repo = parts[1];
    if (owner == null || repo == null || owner === "" || repo === "") {
        throw new Error(`Invalid repository fullName format: ${repoFullName}`);
    }
    return { owner, repo };
}

function mapPullRequest(pr: RawPullRequestLike): PullRequest {
    const merged = pr.merged ?? pr.merged_at != null;
    const state: PullRequestState = merged ? "merged" : pr.state === "closed" ? "closed" : "open";
    return {
        number: pr.number,
        title: pr.title,
        body: pr.body ?? undefined,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        url: pr.html_url,
        authorLogin: pr.user?.login,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        state,
        commitsCount: pr.commits ?? 0,
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

    async getRepositoryArchiveUrl(repoId: number, ref = "HEAD"): Promise<string> {
        const repository = await this.getRepository(repoId);
        const { owner, repo } = parseRepoFullName(repository.fullName);
        const token = await this.getInstallationToken();

        this.logger.info("Resolving repository archive URL", { repoId, fullName: repository.fullName, ref });

        const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            redirect: "manual",
        });

        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location != null) {
            this.logger.info("Resolved repository archive URL", { repoId, fullName: repository.fullName });
            return location;
        }

        if (res.ok) {
            throw new Error("repository archive URL failed: GitHub returned an archive response without a redirect");
        }

        throw new Error(`repository archive URL failed: ${res.status} ${await res.text()}`);
    }

    async listInstallationRepos(): Promise<Repository[]> {
        this.logger.info("Listing installation repositories");

        const repos: Repository[] = [];
        let page = 1;

        while (true) {
            const response = await this.octokit.request("GET /installation/repositories", { per_page: 100, page });

            repos.push(
                ...response.data.repositories.map((r) => ({
                    id: r.id,
                    name: r.name,
                    fullName: r.full_name,
                    defaultBranch: r.default_branch,
                    private: r.private,
                })),
            );

            if (response.data.repositories.length < 100) break;
            page++;
        }

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

    async listPullRequestCommits(repoId: number, prNumber: number): Promise<PullRequestCommit[]> {
        const { owner, repo } = await this.resolveOwnerRepo(repoId);
        this.logger.info("Listing pull request commits", { repoId, prNumber });

        const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
            owner,
            repo,
            pull_number: prNumber,
            per_page: 100,
        });

        const commits = data.map((entry): PullRequestCommit => {
            const authoredAt = entry.commit.author?.date ?? entry.commit.committer?.date ?? "";
            return {
                sha: entry.sha,
                message: entry.commit.message,
                authorLogin: entry.author?.login ?? undefined,
                authoredAt,
            };
        });

        this.logger.info("Listed pull request commits", { repoId, prNumber, count: commits.length });

        return commits;
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

    async postComment(repoFullName: string, prNumber: number, body: string): Promise<string> {
        const { owner, repo } = parseRepoFullName(repoFullName);
        this.logger.info("Posting PR comment", { repoFullName, prNumber });

        const { data } = await this.octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
            owner,
            repo,
            issue_number: prNumber,
            body,
        });

        const commentId = String(data.id);
        this.logger.info("Posted PR comment", { repoFullName, prNumber, commentId });
        return commentId;
    }

    async updateComment(repoFullName: string, commentId: string, body: string): Promise<void> {
        const { owner, repo } = parseRepoFullName(repoFullName);
        this.logger.info("Updating PR comment", { repoFullName, commentId });

        await this.octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
            owner,
            repo,
            comment_id: Number(commentId),
            body,
        });

        this.logger.info("Updated PR comment", { repoFullName, commentId });
    }

    private async resolveOwnerRepo(repoId: number): Promise<{ owner: string; repo: string }> {
        const repository = await this.getRepository(repoId);
        return parseRepoFullName(repository.fullName);
    }
}
