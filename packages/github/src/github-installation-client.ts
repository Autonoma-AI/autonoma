import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Logger, logger } from "@autonoma/logger";
import type { App } from "@octokit/app";
import { z } from "zod";
import type { EtagStore } from "./etag-store";

const execFileAsync = promisify(execFile);
const GITHUB_API = "https://api.github.com";

/** Branch-listing page size. One page is enough for a deploy-branch picker; repos past this are flagged truncated. */
const BRANCHES_PER_PAGE = 100;

const installationAuthSchema = z.object({ token: z.string().min(1) });

/** GitHub's create/get check-run response, narrowed to the numeric id we persist for later updates. */
const checkRunResponseSchema = z.object({ id: z.number() });

/** GitHub's repo-ruleset list response, narrowed to the id + name we match our own ruleset by. */
const rulesetListSchema = z.array(z.object({ id: z.number(), name: z.string() }));

type InstallationOctokit = Awaited<ReturnType<App["getInstallationOctokit"]>>;

export interface Repository {
    id: number;
    name: string;
    fullName: string;
    defaultBranch: string;
    private: boolean;
}

export interface CommitFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
}

export interface Commit {
    sha: string;
    message: string;
    authorLogin?: string;
    files: CommitFile[];
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

/** A PR/issue comment, narrowed to what marker-based comment de-duplication needs. */
export interface IssueComment {
    id: string;
    body: string;
}

/** The GitHub check-run lifecycle status. `completed` is the only status that carries a `conclusion`. */
export type CheckRunStatus = "queued" | "in_progress" | "completed";

/** The terminal outcomes GitHub accepts for a completed check run. The merge gate only uses a subset. */
export type CheckRunConclusion =
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "stale"
    | "skipped";

/**
 * A button rendered on the check run's UI. Clicking one delivers a `check_run`
 * `requested_action` webhook carrying this `identifier` and the acting user. GitHub caps the field lengths:
 * `label` <= 20, `description` <= 40, `identifier` <= 20 characters.
 */
export interface CheckRunAction {
    label: string;
    description: string;
    identifier: string;
}

export interface CreateCheckRunParams {
    repoFullName: string;
    headSha: string;
    name: string;
    status: CheckRunStatus;
    conclusion?: CheckRunConclusion;
    title: string;
    summary: string;
    actions?: CheckRunAction[];
}

export interface UpdateCheckRunParams {
    repoFullName: string;
    checkRunId: string;
    status?: CheckRunStatus;
    conclusion?: CheckRunConclusion;
    title: string;
    summary: string;
    actions?: CheckRunAction[];
}

export interface RequiredCheckRulesetParams {
    repoFullName: string;
    /** The check context to require (e.g. `Autonoma`). */
    contextName: string;
    /** Stable name of the ruleset we create/find/delete, so the operation is idempotent and reversible. */
    rulesetName: string;
}

/**
 * Outcome of a required-status-check ruleset change. `applied` = the `Autonoma` check is now (or is no longer)
 * required on all branches. `no_permission` = the App lacks `administration:write` on the repo (403) - the caller
 * falls back to surfacing manual instructions.
 */
export type BranchProtectionResult = { status: "applied" } | { status: "no_permission" };

/**
 * Result of a conditional open-PR list request. `unchanged` is returned when GitHub
 * answers `304 Not Modified` (the stored ETag still matches), in which case callers
 * keep their existing cache and spend no primary rate-limit budget.
 */
export type ListPullRequestsResult = { unchanged: true } | { unchanged: false; pullRequests: PullRequest[] };

export interface CloneRepositoryParams {
    fullName: string;
    headSha: string;
    baseSha?: string;
    targetDir: string;
    depth?: number;
}

export interface GitTree {
    /** Blob (file) paths only - directories are implied by path prefixes. */
    paths: string[];
    /** True when GitHub truncated the recursive listing (very large repos). */
    truncated: boolean;
}

export interface BranchList {
    /** Branch names, first page only. */
    names: string[];
    /** True when the repo has more branches than the single page returned. */
    truncated: boolean;
}

export interface GitHubInstallationClient {
    getInstallation(installationId: number): Promise<{ account: unknown }>;
    getInstallationToken(): Promise<string>;
    cloneRepository(params: CloneRepositoryParams): Promise<string>;
    getRepository(repoId: number): Promise<Repository>;
    getRepositoryArchiveUrl(repoId: number, ref?: string): Promise<string>;
    listInstallationRepos(): Promise<Repository[]>;
    getPullRequest(repoId: number, prNumber: number): Promise<PullRequest>;
    listOpenPullRequests(repoId: number): Promise<ListPullRequestsResult>;
    listClosedPullRequests(repoId: number): Promise<ListPullRequestsResult>;
    getAssociatedPullRequests(owner: string, repo: string, sha: string): Promise<PullRequest[]>;
    listPullRequestCommits(repoId: number, prNumber: number): Promise<PullRequestCommit[]>;
    getCommit(repoId: number, sha: string): Promise<Commit>;
    getBranchHead(repoId: number, branchName: string): Promise<string>;
    /** Branch names on the repo (first page only); `truncated` is true when the repo has more than the page limit. */
    listBranches(repoId: number): Promise<BranchList>;
    /** Recursive file listing of the repo at `ref`. */
    getGitTree(repoId: number, ref: string): Promise<GitTree>;
    /** Decoded file content at `path`/`ref`, or undefined when the path doesn't exist (or is not a file). */
    getFileContent(repoId: number, path: string, ref: string): Promise<string | undefined>;
    /** Every comment on the PR's conversation timeline (paginated), used to find an existing marker comment. */
    listIssueComments(repoFullName: string, prNumber: number): Promise<IssueComment[]>;
    postComment(repoFullName: string, prNumber: number, body: string): Promise<string>;
    updateComment(repoFullName: string, commentId: string, body: string): Promise<void>;
    deleteComment(repoFullName: string, commentId: string): Promise<void>;
    /** Create a check run on `headSha`; returns GitHub's check-run id. */
    createCheckRun(params: CreateCheckRunParams): Promise<string>;
    /** Update an existing check run. Tolerates a 404 (the check was deleted on GitHub). */
    updateCheckRun(params: UpdateCheckRunParams): Promise<void>;
    /** Require `contextName` as a status check on ALL branches via a repo ruleset. */
    requireStatusCheckOnAllBranches(params: RequiredCheckRulesetParams): Promise<BranchProtectionResult>;
    /** Remove the ruleset named `rulesetName`, so the check is no longer required. */
    removeRequiredStatusCheckRuleset(
        params: Pick<RequiredCheckRulesetParams, "repoFullName" | "rulesetName">,
    ): Promise<BranchProtectionResult>;
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

function isNotFoundError(error: unknown): boolean {
    return typeof error === "object" && error != null && "status" in error && error.status === 404;
}

/**
 * Build an environment for `git` that supplies the installation token as an
 * `Authorization` header via env-based config (`GIT_CONFIG_*`). This avoids
 * putting the token in the process argv or the cloned remote URL, so it can't
 * leak through git's stderr or an `execFile` error.
 */
function buildAuthenticatedGitEnv(token: string): NodeJS.ProcessEnv {
    const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
    return {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basicAuth}`,
    };
}

/**
 * Replace every occurrence of `secret` in an error (message and any string
 * fields like `stderr`/`cmd`) with `***`. Used as defense in depth so a git
 * failure can never surface the installation token to callers that log it.
 */
function redactSecret(error: unknown, secret: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (secret.length === 0) return error instanceof Error ? error : new Error(message);
    return new Error(message.split(secret).join("***"));
}

/** Typed wrapper around an installation-scoped Octokit. */
export class OctokitGitHubInstallationClient implements GitHubInstallationClient {
    private readonly logger: Logger;

    constructor(
        private readonly octokit: InstallationOctokit,
        private readonly installationId: number,
        private readonly etagStore?: EtagStore,
    ) {
        this.logger = logger.child({ name: this.constructor.name, installationId });
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
        const { token } = installationAuthSchema.parse(await this.octokit.auth({ type: "installation" }));
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

        // Pass credentials via env-based git config rather than embedding the
        // token in the clone URL. This keeps the token out of the process argv,
        // out of the stored `origin` remote URL, and out of git's stderr - so a
        // failing git command can't leak it into logs/Sentry via the error.
        const gitEnv = buildAuthenticatedGitEnv(token);
        const cloneUrl = `https://github.com/${fullName}.git`;

        try {
            this.logger.info("Cloning repository", { fullName, headSha, targetDir });
            await execFileAsync("git", ["clone", `--depth=${depth}`, cloneUrl, targetDir], {
                maxBuffer: 10 * 1024 * 1024,
                timeout: 120_000,
                env: gitEnv,
            });

            this.logger.info("Checking out commit", { headSha });
            try {
                await execFileAsync("git", ["checkout", headSha], { cwd: targetDir });
            } catch (err) {
                this.logger.info("Head SHA not in shallow clone, fetching explicitly", { headSha, err });
                await execFileAsync("git", ["fetch", `--depth=${depth}`, "origin", headSha], {
                    cwd: targetDir,
                    timeout: 60_000,
                    env: gitEnv,
                });
                await execFileAsync("git", ["checkout", headSha], { cwd: targetDir });
            }

            if (baseSha != null) {
                this.logger.info("Ensuring base commit is available", { baseSha });
                try {
                    await execFileAsync("git", ["cat-file", "-t", baseSha], { cwd: targetDir });
                } catch (err) {
                    this.logger.debug("Base SHA not in shallow clone, fetching explicitly", { baseSha, err });
                    await execFileAsync("git", ["fetch", `--depth=${depth}`, "origin", baseSha], {
                        cwd: targetDir,
                        timeout: 60_000,
                        env: gitEnv,
                    });
                }
            }

            this.logger.info("Repository cloned successfully", { fullName, targetDir });
            return targetDir;
        } catch (err) {
            // Defense in depth: redact the installation token from any git error
            // before it propagates to callers that log it.
            throw redactSecret(err, token);
        }
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

        const pullRequest = this.mapPullRequest(pr);

        this.logger.info("Fetched pull request", { repoId, prNumber, headRef: pullRequest.headRef });

        return pullRequest;
    }

    /**
     * Normalizes a raw GitHub pull request (from any list/detail endpoint) into our
     * domain {@link PullRequest}. Collapses GitHub's separate `state` ("open"/"closed")
     * and `merged`/`merged_at` fields into a single `state` of "open" | "closed" |
     * "merged", and maps snake_case API fields to our camelCase shape. Shared by every
     * method that returns PRs (getPullRequest, listOpenPullRequests, getAssociatedPullRequests).
     */
    private mapPullRequest(pr: RawPullRequestLike): PullRequest {
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

    /**
     * Lists the 100 most-recently-updated open PRs as a single conditional request.
     * When an ETag store is wired, sends `If-None-Match` and returns `{ unchanged: true }`
     * on a `304` (free against the primary rate limit). One page is intentional: the
     * polite revalidate only needs the freshest open PRs, and stragglers are handled by
     * the caller's bounded backfill - a single request keeps the 304 semantics clean.
     */
    async listOpenPullRequests(repoId: number): Promise<ListPullRequestsResult> {
        return this.listPullRequests(repoId, "open");
    }

    /**
     * Lists the 100 most-recently-updated *closed* PRs as a single conditional request.
     * GitHub returns merged PRs here too (state="closed"); {@link mapPullRequest} reads
     * `merged_at` to split them into "merged" vs "closed". One bounded page is intentional:
     * the cache only needs to classify PRs that *just* left the open list, and the freshest
     * closed PRs are exactly the recently merged/closed ones. We never paginate the full
     * closed history - that is thousands of PRs and previously OOM-killed the API (#895).
     */
    async listClosedPullRequests(repoId: number): Promise<ListPullRequestsResult> {
        return this.listPullRequests(repoId, "closed");
    }

    private async listPullRequests(repoId: number, state: "open" | "closed"): Promise<ListPullRequestsResult> {
        const { owner, repo } = await this.resolveOwnerRepo(repoId);
        const requestKey = `pulls:${state}:repo=${repoId}`;
        this.logger.info("Listing pull requests", { repoId, extra: { state } });

        const storedEtag = await this.etagStore?.get(this.installationId, requestKey);
        const headers = storedEtag != null ? { "if-none-match": storedEtag } : {};

        try {
            const response = await this.octokit.request("GET /repos/{owner}/{repo}/pulls", {
                owner,
                repo,
                state,
                sort: "updated",
                direction: "desc",
                per_page: 100,
                headers,
            });

            const newEtag = response.headers.etag;
            if (newEtag != null && this.etagStore != null) {
                await this.etagStore.set(this.installationId, requestKey, newEtag);
            }

            const pullRequests = response.data.map((pr) => this.mapPullRequest(pr));
            this.logger.info("Listed pull requests", { repoId, extra: { state, count: pullRequests.length } });
            return { unchanged: false, pullRequests };
        } catch (error) {
            if (this.isNotModified(error)) {
                this.logger.info("Pull request list unchanged (304)", { repoId, extra: { state } });
                return { unchanged: true };
            }
            throw error;
        }
    }

    /**
     * True when a request failed with a `304 Not Modified`. Octokit surfaces a 304
     * (returned for a conditional `If-None-Match` request whose ETag still matches) as a
     * thrown RequestError with `status === 304`, so we detect it on the error rather than
     * the response. Lets {@link listOpenPullRequests} treat "unchanged" as success.
     */
    private isNotModified(error: unknown): boolean {
        if (error == null || typeof error !== "object") return false;
        if (!("status" in error)) return false;
        return error.status === 304;
    }

    /**
     * True when a request failed with a `404 Not Found`. Lets {@link deleteComment}
     * treat "comment already gone" as success, keeping deletes idempotent.
     */
    private isNotFound(error: unknown): boolean {
        if (error == null || typeof error !== "object") return false;
        if (!("status" in error)) return false;
        return error.status === 404;
    }

    /**
     * True when a request failed with a `403 Forbidden`. The branch-protection endpoints return 403 when the
     * installation lacks `administration:write` on the repo; the caller maps this to `no_permission` and falls
     * back to manual instructions rather than throwing.
     */
    private isForbidden(error: unknown): boolean {
        if (error == null || typeof error !== "object") return false;
        if (!("status" in error)) return false;
        return error.status === 403;
    }

    async getAssociatedPullRequests(owner: string, repo: string, sha: string): Promise<PullRequest[]> {
        this.logger.info("Fetching pull requests associated with commit", { owner, repo, sha });

        const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", {
            owner,
            repo,
            commit_sha: sha,
            per_page: 100,
        });

        const pullRequests = data.map((pr) => this.mapPullRequest(pr));

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

        const files: CommitFile[] = (data.files ?? []).map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
        }));

        const commit: Commit = {
            sha: data.sha,
            message: data.commit.message,
            authorLogin: data.author?.login,
            files,
        };

        this.logger.info("Fetched commit", { repoId, sha: commit.sha, fileCount: files.length });

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

    async listBranches(repoId: number): Promise<BranchList> {
        const { owner, repo } = await this.resolveOwnerRepo(repoId);
        this.logger.info("Listing branches", { repoId });

        const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/branches", {
            owner,
            repo,
            per_page: BRANCHES_PER_PAGE,
        });

        const names = data.map((branch) => branch.name);
        const truncated = data.length === BRANCHES_PER_PAGE;
        this.logger.info("Listed branches", { repoId, count: names.length, truncated });
        return { names, truncated };
    }

    async getGitTree(repoId: number, ref: string): Promise<GitTree> {
        const { owner, repo } = await this.resolveOwnerRepo(repoId);
        this.logger.info("Fetching git tree", { repoId, ref });

        const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
            owner,
            repo,
            tree_sha: ref,
            recursive: "1",
        });

        const paths: string[] = [];
        for (const entry of data.tree) {
            if (entry.type === "blob" && entry.path != null) paths.push(entry.path);
        }
        const truncated = data.truncated === true;

        this.logger.info("Fetched git tree", { repoId, ref, fileCount: paths.length, truncated });

        return { paths, truncated };
    }

    async getFileContent(repoId: number, path: string, ref: string): Promise<string | undefined> {
        const { owner, repo } = await this.resolveOwnerRepo(repoId);
        this.logger.info("Fetching file content", { repoId, path, ref });

        try {
            const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
                owner,
                repo,
                path,
                ref,
            });

            if (Array.isArray(data) || data.type !== "file") return undefined;

            return Buffer.from(data.content, "base64").toString("utf-8");
        } catch (error: unknown) {
            if (isNotFoundError(error)) {
                this.logger.info("File not found", { repoId, path, ref });
                return undefined;
            }
            throw error;
        }
    }

    async listIssueComments(repoFullName: string, prNumber: number): Promise<IssueComment[]> {
        const { owner, repo } = parseRepoFullName(repoFullName);
        this.logger.info("Listing PR comments", { repoFullName, prNumber });

        const comments: IssueComment[] = [];
        let page = 1;
        while (true) {
            const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
                owner,
                repo,
                issue_number: prNumber,
                per_page: 100,
                page,
            });
            for (const comment of data) {
                comments.push({ id: String(comment.id), body: comment.body ?? "" });
            }
            if (data.length < 100) break;
            page++;
        }

        this.logger.info("Listed PR comments", { repoFullName, prNumber, count: comments.length });
        return comments;
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

    async deleteComment(repoFullName: string, commentId: string): Promise<void> {
        const { owner, repo } = parseRepoFullName(repoFullName);
        this.logger.info("Deleting PR comment", { repoFullName, commentId });

        try {
            await this.octokit.request("DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}", {
                owner,
                repo,
                comment_id: Number(commentId),
            });
        } catch (error) {
            // Deleting an already-deleted comment is success for our purposes - the
            // GitHubCommentClient contract requires deleteComment to be idempotent.
            if (this.isNotFound(error)) {
                this.logger.info("PR comment already deleted (404)", { repoFullName, commentId });
                return;
            }
            throw error;
        }

        this.logger.info("Deleted PR comment", { repoFullName, commentId });
    }

    async createCheckRun(params: CreateCheckRunParams): Promise<string> {
        const { owner, repo } = parseRepoFullName(params.repoFullName);
        this.logger.info("Creating check run", {
            repoFullName: params.repoFullName,
            extra: { name: params.name, headSha: params.headSha, status: params.status },
        });

        const { data } = await this.octokit.request("POST /repos/{owner}/{repo}/check-runs", {
            owner,
            repo,
            name: params.name,
            head_sha: params.headSha,
            status: params.status,
            // GitHub rejects a conclusion unless the status is `completed`; only forward it for that status.
            conclusion: params.status === "completed" ? params.conclusion : undefined,
            output: { title: params.title, summary: params.summary },
            actions: params.actions,
        });

        const checkRunId = String(checkRunResponseSchema.parse(data).id);
        this.logger.info("Created check run", { repoFullName: params.repoFullName, extra: { checkRunId } });
        return checkRunId;
    }

    async updateCheckRun(params: UpdateCheckRunParams): Promise<void> {
        const { owner, repo } = parseRepoFullName(params.repoFullName);
        this.logger.info("Updating check run", {
            repoFullName: params.repoFullName,
            extra: { checkRunId: params.checkRunId, status: params.status, conclusion: params.conclusion },
        });

        try {
            await this.octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
                owner,
                repo,
                check_run_id: Number(params.checkRunId),
                status: params.status,
                conclusion: params.conclusion,
                output: { title: params.title, summary: params.summary },
                actions: params.actions,
            });
        } catch (error) {
            // Tolerate a check that was deleted on GitHub (e.g. the head SHA was force-pushed away). Nothing to
            // update, so treat it as a no-op rather than failing the caller.
            if (this.isNotFound(error)) {
                this.logger.warn("Check run not found on update (deleted on GitHub); no-op", {
                    repoFullName: params.repoFullName,
                    extra: { checkRunId: params.checkRunId },
                });
                return;
            }
            throw error;
        }

        this.logger.info("Updated check run", {
            repoFullName: params.repoFullName,
            extra: { checkRunId: params.checkRunId },
        });
    }

    async requireStatusCheckOnAllBranches(params: RequiredCheckRulesetParams): Promise<BranchProtectionResult> {
        const { owner, repo } = parseRepoFullName(params.repoFullName);
        this.logger.info("Requiring status check on all branches via ruleset", {
            repoFullName: params.repoFullName,
            extra: { contextName: params.contextName, rulesetName: params.rulesetName },
        });

        try {
            const existing = await this.findRulesetIdByName(owner, repo, params.rulesetName);
            if (existing != null) {
                this.logger.info("Required-status-check ruleset already present", {
                    repoFullName: params.repoFullName,
                    extra: { rulesetName: params.rulesetName },
                });
                return { status: "applied" };
            }

            // A branch ruleset targeting every branch (`~ALL`) that requires the check.
            await this.octokit.request("POST /repos/{owner}/{repo}/rulesets", {
                owner,
                repo,
                name: params.rulesetName,
                target: "branch",
                enforcement: "active",
                conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
                rules: [
                    {
                        type: "required_status_checks",
                        parameters: {
                            required_status_checks: [{ context: params.contextName }],
                            strict_required_status_checks_policy: false,
                        },
                    },
                ],
            });
        } catch (error) {
            return this.mapRulesetError(error, params.repoFullName, "create");
        }

        this.logger.info("Required status check on all branches", {
            repoFullName: params.repoFullName,
            extra: { rulesetName: params.rulesetName },
        });
        return { status: "applied" };
    }

    async removeRequiredStatusCheckRuleset(
        params: Pick<RequiredCheckRulesetParams, "repoFullName" | "rulesetName">,
    ): Promise<BranchProtectionResult> {
        const { owner, repo } = parseRepoFullName(params.repoFullName);
        this.logger.info("Removing required-status-check ruleset", {
            repoFullName: params.repoFullName,
            extra: { rulesetName: params.rulesetName },
        });

        try {
            const rulesetId = await this.findRulesetIdByName(owner, repo, params.rulesetName);
            if (rulesetId == null) {
                return { status: "applied" };
            }
            await this.octokit.request("DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
                owner,
                repo,
                ruleset_id: rulesetId,
            });
        } catch (error) {
            return this.mapRulesetError(error, params.repoFullName, "delete");
        }

        this.logger.info("Removed required-status-check ruleset", {
            repoFullName: params.repoFullName,
            extra: { rulesetName: params.rulesetName },
        });
        return { status: "applied" };
    }

    /** The id of the repo ruleset named `rulesetName`, or undefined when none exists. */
    private async findRulesetIdByName(owner: string, repo: string, rulesetName: string): Promise<number | undefined> {
        const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/rulesets", { owner, repo });
        const rulesets = rulesetListSchema.parse(data);
        return rulesets.find((ruleset) => ruleset.name === rulesetName)?.id;
    }

    /** Map a ruleset request failure to a typed result, or rethrow anything unexpected. */
    private mapRulesetError(
        error: unknown,
        repoFullName: string,
        operation: "create" | "delete",
    ): BranchProtectionResult {
        if (this.isForbidden(error)) {
            this.logger.warn("No permission to manage repo rulesets (lacks administration:write)", {
                repoFullName,
                extra: { operation },
            });
            return { status: "no_permission" };
        }
        throw error;
    }

    private async resolveOwnerRepo(repoId: number): Promise<{ owner: string; repo: string }> {
        const repository = await this.getRepository(repoId);
        return parseRepoFullName(repository.fullName);
    }
}
