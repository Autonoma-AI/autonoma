import { type Logger, logger } from "@autonoma/logger";
import type {
    BranchList,
    BranchProtectionResult,
    CloneRepositoryParams,
    Commit,
    CreateCheckRunParams,
    GitHubInstallationClient,
    GitTree,
    IssueComment,
    ListPullRequestsResult,
    PullRequest,
    PullRequestCommit,
    Repository,
    RequiredCheckRulesetParams,
    UpdateCheckRunParams,
} from "../github-installation-client";

const NOT_SUPPORTED = "not supported in LOCAL_DEV mode";

const LOCAL_REPOS: Repository[] = [
    { id: 1, name: "web-app", fullName: "local-org/web-app", defaultBranch: "main", private: false },
    { id: 2, name: "marketing-site", fullName: "local-org/marketing-site", defaultBranch: "main", private: false },
    { id: 3, name: "mobile-app", fullName: "local-org/mobile-app", defaultBranch: "main", private: true },
];

const PRS_PER_REPO: ReadonlyArray<{ number: number; title: string; headRef: string; authorLogin: string }> = [
    { number: 1, title: "Add login page", headRef: "feat/login", authorLogin: "alice" },
    { number: 2, title: "Fix flaky checkout tests", headRef: "fix/checkout", authorLogin: "bob" },
    { number: 3, title: "Refactor dashboard layout", headRef: "refactor/dashboard", authorLogin: "carol" },
];

const FIXED_TIMESTAMP = "2026-01-01T00:00:00Z";

export class LocalDevGitHubInstallationClient implements GitHubInstallationClient {
    private readonly logger: Logger;

    constructor() {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async getInstallation(_installationId: number): Promise<{ account: unknown }> {
        throw new Error(`getInstallation ${NOT_SUPPORTED}`);
    }

    async getInstallationToken(): Promise<string> {
        throw new Error(`getInstallationToken ${NOT_SUPPORTED}`);
    }

    async cloneRepository(_params: CloneRepositoryParams): Promise<string> {
        throw new Error(`cloneRepository ${NOT_SUPPORTED}`);
    }

    async getRepository(repoId: number): Promise<Repository> {
        this.logger.info("Returning local-dev repository", { repoId });
        const preset = LOCAL_REPOS.find((r) => r.id === repoId);
        if (preset != null) return preset;
        return {
            id: repoId,
            name: `local-repo-${repoId}`,
            fullName: `local-org/local-repo-${repoId}`,
            defaultBranch: "main",
            private: false,
        };
    }

    async listInstallationRepos(): Promise<Repository[]> {
        this.logger.info("Returning local-dev repository list", { count: LOCAL_REPOS.length });
        return LOCAL_REPOS;
    }

    async getRepositoryArchiveUrl(repoId: number, ref = "HEAD"): Promise<string> {
        this.logger.info("Returning local-dev repository archive URL", { repoId, ref });
        const repo = await this.getRepository(repoId);
        return `https://github.com/${repo.fullName}/archive/${ref}.tar.gz`;
    }

    async getPullRequest(repoId: number, prNumber: number): Promise<PullRequest> {
        this.logger.info("Returning local-dev pull request", { repoId, prNumber });
        const preset = PRS_PER_REPO.find((pr) => pr.number === prNumber);
        const title = preset?.title ?? `Local dev PR #${prNumber}`;
        const headRef = preset?.headRef ?? `local-dev/pr-${prNumber}`;
        const authorLogin = preset?.authorLogin ?? "local-dev-user";
        const repo = await this.getRepository(repoId);

        return {
            number: prNumber,
            title,
            body: `Local dev description for PR #${prNumber}. Replace with real data once connected to GitHub.`,
            headRef,
            headSha: `head-${repoId}-${prNumber}`,
            baseRef: repo.defaultBranch,
            baseSha: `base-${repoId}-${prNumber}`,
            url: `https://github.com/${repo.fullName}/pull/${prNumber}`,
            authorLogin,
            createdAt: FIXED_TIMESTAMP,
            updatedAt: FIXED_TIMESTAMP,
            state: "open",
            commitsCount: 3,
            merged: false,
        };
    }

    async listOpenPullRequests(repoId: number): Promise<ListPullRequestsResult> {
        this.logger.info("Returning local-dev pull request list", { repoId });
        const pullRequests = await Promise.all(PRS_PER_REPO.map((pr) => this.getPullRequest(repoId, pr.number)));
        return { unchanged: false, pullRequests };
    }

    async listClosedPullRequests(repoId: number): Promise<ListPullRequestsResult> {
        this.logger.info("Returning local-dev closed pull request list (none)", { repoId });
        // Local-dev presets are all open; there is no closed history to model.
        return { unchanged: false, pullRequests: [] };
    }

    async getAssociatedPullRequests(owner: string, repo: string, sha: string): Promise<PullRequest[]> {
        this.logger.info("Returning local-dev associated pull requests", { owner, repo, sha });
        return [];
    }

    async listPullRequestCommits(repoId: number, prNumber: number): Promise<PullRequestCommit[]> {
        this.logger.info("Returning local-dev pull request commits", { repoId, prNumber });
        return [
            {
                sha: `head-${repoId}-${prNumber}`,
                message: "Implement feature",
                authorLogin: "local-dev-user",
                authoredAt: FIXED_TIMESTAMP,
            },
            {
                sha: `head-${repoId}-${prNumber}-b`,
                message: "Address review feedback",
                authorLogin: "local-dev-user",
                authoredAt: FIXED_TIMESTAMP,
            },
            {
                sha: `head-${repoId}-${prNumber}-c`,
                message: "Fix tests",
                authorLogin: "local-dev-user",
                authoredAt: FIXED_TIMESTAMP,
            },
        ];
    }

    async getCommit(repoId: number, sha: string): Promise<Commit> {
        this.logger.info("Returning local-dev commit", { repoId, sha });
        return {
            sha,
            message: `Local dev commit ${sha}`,
            authorLogin: "local-dev-user",
            files: [
                { filename: "apps/web/hero/HeroCta.tsx", status: "modified", additions: 24, deletions: 6 },
                { filename: "apps/web/hero/hero.css", status: "modified", additions: 8, deletions: 2 },
                { filename: "apps/api/experiments/assign.ts", status: "added", additions: 41, deletions: 0 },
            ],
        };
    }

    async getBranchHead(repoId: number, branchName: string): Promise<string> {
        this.logger.info("Returning local-dev branch head", { repoId, branchName });
        return `head-${repoId}-${branchName}`;
    }

    async listBranches(repoId: number): Promise<BranchList> {
        this.logger.info("Returning local-dev branches", { repoId });
        return { names: ["main", "develop"], truncated: false };
    }

    async getGitTree(repoId: number, ref: string): Promise<GitTree> {
        this.logger.info("Returning local-dev git tree", { repoId, ref });
        return {
            paths: [
                "package.json",
                "pnpm-workspace.yaml",
                "apps/web/package.json",
                "apps/web/Dockerfile",
                "apps/api/package.json",
            ],
            truncated: false,
        };
    }

    async getFileContent(repoId: number, path: string, ref: string): Promise<string | undefined> {
        this.logger.info("Returning local-dev file content", { repoId, path, ref });
        if (path === "pnpm-workspace.yaml") return 'packages:\n  - "apps/*"\n';
        if (path === "package.json") return JSON.stringify({ name: "local-dev-root", private: true });
        if (path === "apps/web/package.json") {
            return JSON.stringify({ name: "web", scripts: { dev: "next dev -p 3000" }, dependencies: { next: "*" } });
        }
        if (path === "apps/api/package.json") {
            return JSON.stringify({ name: "api", scripts: { start: "node server.js" } });
        }
        return undefined;
    }

    async listIssueComments(repoFullName: string, prNumber: number): Promise<IssueComment[]> {
        this.logger.info("Skipping local-dev PR comment list", { repoFullName, prNumber });
        return [];
    }

    async postComment(repoFullName: string, prNumber: number, _body: string): Promise<string> {
        this.logger.info("Skipping local-dev PR comment post", { repoFullName, prNumber });
        return `local-dev-comment-${repoFullName}-${prNumber}`;
    }

    async updateComment(repoFullName: string, commentId: string, _body: string): Promise<void> {
        this.logger.info("Skipping local-dev PR comment update", { repoFullName, commentId });
    }

    async deleteComment(repoFullName: string, commentId: string): Promise<void> {
        this.logger.info("Skipping local-dev PR comment delete", { repoFullName, commentId });
    }

    async createCheckRun(params: CreateCheckRunParams): Promise<string> {
        this.logger.info("Skipping local-dev check run create", {
            repoFullName: params.repoFullName,
            extra: { name: params.name, headSha: params.headSha, status: params.status },
        });
        return `local-dev-check-run-${params.repoFullName}-${params.headSha}`;
    }

    async updateCheckRun(params: UpdateCheckRunParams): Promise<void> {
        this.logger.info("Skipping local-dev check run update", {
            repoFullName: params.repoFullName,
            extra: { checkRunId: params.checkRunId, conclusion: params.conclusion },
        });
    }

    async requireStatusCheckOnAllBranches(params: RequiredCheckRulesetParams): Promise<BranchProtectionResult> {
        this.logger.info("Skipping local-dev required-status-check ruleset create", {
            repoFullName: params.repoFullName,
            extra: { contextName: params.contextName, rulesetName: params.rulesetName },
        });
        return { status: "applied" };
    }

    async removeRequiredStatusCheckRuleset(
        params: Pick<RequiredCheckRulesetParams, "repoFullName" | "rulesetName">,
    ): Promise<BranchProtectionResult> {
        this.logger.info("Skipping local-dev required-status-check ruleset remove", {
            repoFullName: params.repoFullName,
            extra: { rulesetName: params.rulesetName },
        });
        return { status: "applied" };
    }
}
