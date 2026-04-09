import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Logger, logger } from "@autonoma/logger";
import type { App } from "@octokit/app";
import { OctokitGithubHistory } from "./history/octokit-github-history";

const execFileAsync = promisify(execFile);

type InstallationOctokit = Awaited<ReturnType<App["getInstallationOctokit"]>>;

export interface CompareCommitsResult {
    aheadBy: number;
    behindBy: number;
    status: string;
    files: Array<{
        filename: string;
        patch?: string;
    }>;
}

export interface Commit {
    sha: string;
}

export interface Repository {
    id: number;
    name: string;
    fullName: string;
    defaultBranch: string;
    private: boolean;
}

export interface TreeEntry {
    path?: string;
    mode?: string;
    type?: string;
    sha?: string;
    size?: number;
}

export interface FileContent {
    content: string;
    encoding: string;
    sha: string;
    path: string;
}

export interface PullRequest {
    number: number;
    title: string;
    headRef: string;
    headSha: string;
    url: string;
    createdAt: string;
    updatedAt: string;
}

export interface CloneRepositoryParams {
    fullName: string;
    headSha: string;
    baseSha?: string;
    targetDir: string;
    depth?: number;
}

/** Typed wrapper around an installation-scoped Octokit. */
export class GitHubInstallationClient {
    private readonly logger: Logger;

    constructor(private readonly octokit: InstallationOctokit) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async compareCommits(owner: string, repo: string, base: string, head: string): Promise<CompareCommitsResult> {
        this.logger.info("Comparing commits", { owner, repo, base, head });

        const response = await this.octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
            owner,
            repo,
            basehead: `${base}...${head}`,
        });

        const result = {
            aheadBy: response.data.ahead_by,
            behindBy: response.data.behind_by,
            status: response.data.status,
            files: (response.data.files ?? []).map((f) => ({
                filename: f.filename,
                patch: f.patch,
            })),
        };

        this.logger.info("Compare commits result", {
            owner,
            repo,
            status: result.status,
            aheadBy: result.aheadBy,
            behindBy: result.behindBy,
            fileCount: result.files.length,
        });

        return result;
    }

    async listCommits(owner: string, repo: string, options?: { sha?: string; perPage?: number }): Promise<Commit[]> {
        this.logger.info("Listing commits", { owner, repo, sha: options?.sha, perPage: options?.perPage });

        const response = await this.octokit.request("GET /repos/{owner}/{repo}/commits", {
            owner,
            repo,
            sha: options?.sha,
            per_page: options?.perPage ?? 1,
        });

        const commits = response.data.map((c) => ({ sha: c.sha }));
        this.logger.info("Listed commits", { owner, repo, count: commits.length });

        return commits;
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

    async createIssue(
        owner: string,
        repo: string,
        title: string,
        body: string,
        labels?: string[],
    ): Promise<{ number: number; url: string }> {
        this.logger.info("Creating issue", { owner, repo, title, labels });

        const { data: issue } = await this.octokit.request("POST /repos/{owner}/{repo}/issues", {
            owner,
            repo,
            title,
            body,
            labels,
        });

        this.logger.info("Created issue", { owner, repo, issueNumber: issue.number, issueUrl: issue.html_url });

        return { number: issue.number, url: issue.html_url };
    }

    async getTree(owner: string, repo: string, treeSha: string, recursive?: boolean): Promise<TreeEntry[]> {
        this.logger.info("Fetching tree", { owner, repo, treeSha, recursive });

        const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
            owner,
            repo,
            tree_sha: treeSha,
            recursive: recursive === true ? "1" : undefined,
        });

        const entries = data.tree.map((t) => ({
            path: t.path,
            mode: t.mode,
            type: t.type,
            sha: t.sha,
            size: t.size,
        }));

        this.logger.info("Fetched tree", { owner, repo, treeSha, entryCount: entries.length });

        return entries;
    }

    getHistory(owner: string, repo: string, branchRef: string): OctokitGithubHistory {
        return new OctokitGithubHistory(this, owner, repo, branchRef);
    }

    async listPullRequests(owner: string, repo: string): Promise<PullRequest[]> {
        this.logger.info("Listing open pull requests", { owner, repo });

        const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/pulls", {
            owner,
            repo,
            state: "open",
            per_page: 50,
        });

        const pullRequests = data.map((pr) => ({
            number: pr.number,
            title: pr.title,
            headRef: pr.head.ref,
            headSha: pr.head.sha,
            url: pr.html_url,
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
        }));

        this.logger.info("Listed pull requests", { owner, repo, count: pullRequests.length });

        return pullRequests;
    }

    async getContent(owner: string, repo: string, path: string, ref?: string): Promise<FileContent> {
        this.logger.debug("Fetching file content", { owner, repo, path, ref });

        const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
            owner,
            repo,
            path,
            ref,
        });

        if (Array.isArray(data) || data.type !== "file") {
            throw new Error(`Expected a file at ${path}, got ${Array.isArray(data) ? "directory listing" : data.type}`);
        }

        return {
            content: data.content ?? "",
            encoding: data.encoding,
            sha: data.sha,
            path: data.path,
        };
    }
}
