import { type Logger, logger } from "@autonoma/logger";
import type {
    CloneRepositoryParams,
    Commit,
    GitHubInstallationClient,
    PullRequest,
    Repository,
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
            headRef,
            headSha: `head-${repoId}-${prNumber}`,
            baseSha: `base-${repoId}-${prNumber}`,
            url: `https://github.com/${repo.fullName}/pull/${prNumber}`,
            authorLogin,
            createdAt: FIXED_TIMESTAMP,
            updatedAt: FIXED_TIMESTAMP,
        };
    }

    async listPullRequests(repoId: number): Promise<PullRequest[]> {
        this.logger.info("Returning local-dev pull request list", { repoId });
        return Promise.all(PRS_PER_REPO.map((pr) => this.getPullRequest(repoId, pr.number)));
    }

    async getCommit(repoId: number, sha: string): Promise<Commit> {
        this.logger.info("Returning local-dev commit", { repoId, sha });
        return {
            sha,
            message: `Local dev commit ${sha}`,
            authorLogin: "local-dev-user",
        };
    }
}
