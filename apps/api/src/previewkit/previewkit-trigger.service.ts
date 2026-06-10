import type { PrismaClient } from "@autonoma/db";
import { ConflictError, NotFoundError } from "@autonoma/errors";
import type { TriggerPreviewDeployParams, TriggerPreviewTeardownParams } from "@autonoma/workflow";
import { z } from "zod";
import type { GitHubInstallationService } from "../github/github-installation.service";
import { Service } from "../routes/service";

export const MAIN_BRANCH_ENVIRONMENT_NUMBER = 0;

export type PreviewDeployAction = "opened" | "synchronize" | "reopened";

export interface PreviewkitDeployRequest {
    repoFullName: string;
    prNumber: number;
    organizationId: string;
    githubRepositoryId: number;
    headSha: string;
    headRef: string;
    baseSha?: string | undefined;
    baseRef?: string | undefined;
    cloneUrl: string;
}

export interface PreviewkitTeardownRequest {
    repoFullName: string;
    prNumber: number;
    organizationId: string;
    githubRepositoryId: number;
    /** Optional; the teardown activity falls back to the environment row's stored sha. */
    headSha?: string | undefined;
    headRef?: string | undefined;
}

export interface MainBranchDeployResult {
    applicationId: string;
    repoFullName: string;
    branch: string;
    headSha: string;
    prNumber: number;
}

/** The two GitHub reads the main-branch preflight needs. */
export type PreviewkitGitHubReader = Pick<GitHubInstallationService, "getRepository" | "getBranchHead">;

/** The pull_request webhook fields the preview lifecycle needs. */
const pullRequestWebhookSchema = z.object({
    pull_request: z.object({
        number: z.number().int().positive(),
        head: z.object({ sha: z.string(), ref: z.string() }),
        base: z.object({ sha: z.string(), ref: z.string() }),
    }),
    repository: z.object({
        id: z.number().int().positive(),
        full_name: z.string(),
        clone_url: z.string(),
    }),
});

/**
 * Starts preview-environment Temporal workflows directly from the API - the
 * native replacement for forwarding deploy/teardown/redeploy over HTTP to
 * Previewkit. One workflow execution per PR per action; deploy and teardown
 * share a deterministic workflowId, so starting either supersedes whatever is
 * in flight for that PR (the trigger functions own that policy).
 */
export class PreviewkitTriggerService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly githubInstallationService: PreviewkitGitHubReader,
        private readonly triggerDeploy: (params: TriggerPreviewDeployParams) => Promise<void>,
        private readonly triggerTeardown: (params: TriggerPreviewTeardownParams) => Promise<void>,
    ) {
        super();
    }

    /** Starts a deploy workflow for a PR. `configRevisionId` pins a redeploy's original topology. */
    async deploy(
        request: PreviewkitDeployRequest,
        action: PreviewDeployAction = "opened",
        configRevisionId?: string,
    ): Promise<void> {
        this.logger.info("Triggering preview deploy", {
            repo: request.repoFullName,
            pr: request.prNumber,
            action,
        });

        await this.triggerDeploy({
            event: {
                action,
                prNumber: request.prNumber,
                repoFullName: request.repoFullName,
                organizationId: request.organizationId,
                githubRepositoryId: request.githubRepositoryId,
                headSha: request.headSha,
                headRef: request.headRef,
                baseSha: request.baseSha ?? "",
                baseRef: request.baseRef ?? "",
                cloneUrl: request.cloneUrl,
            },
            configRevisionId,
        });
    }

    /** Starts a teardown workflow for a PR (terminates an in-flight deploy first via the shared workflowId). */
    async teardown(request: PreviewkitTeardownRequest): Promise<void> {
        this.logger.info("Triggering preview teardown", { repo: request.repoFullName, pr: request.prNumber });

        await this.triggerTeardown({
            event: {
                action: "closed",
                prNumber: request.prNumber,
                repoFullName: request.repoFullName,
                organizationId: request.organizationId,
                githubRepositoryId: request.githubRepositoryId,
                headSha: request.headSha ?? "",
                headRef: request.headRef ?? "",
                baseSha: "",
                baseRef: "",
                cloneUrl: "",
            },
        });
    }

    /**
     * Deploy entry point for `pull_request` opened/synchronize/reopened
     * webhooks. An unparseable payload is logged and skipped (GitHub retries
     * non-2xx deliveries, and a malformed payload won't get better).
     */
    async deployFromWebhook(
        action: PreviewDeployAction,
        organizationId: string,
        payload: Record<string, unknown>,
    ): Promise<void> {
        const parsed = pullRequestWebhookSchema.safeParse(payload);
        if (!parsed.success) {
            this.logger.warn("Pull request webhook missing pull_request or repository payload", {
                action,
                organizationId,
            });
            return;
        }

        const { pull_request: pr, repository: repo } = parsed.data;
        await this.deploy(
            {
                repoFullName: repo.full_name,
                prNumber: pr.number,
                organizationId,
                githubRepositoryId: repo.id,
                headSha: pr.head.sha,
                headRef: pr.head.ref,
                baseSha: pr.base.sha,
                baseRef: pr.base.ref,
                cloneUrl: repo.clone_url,
            },
            action,
        );
    }

    /** Teardown entry point for `pull_request.closed` webhooks. */
    async teardownFromWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        const parsed = pullRequestWebhookSchema.safeParse(payload);
        if (!parsed.success) {
            this.logger.warn("Pull request webhook missing pull_request or repository payload", {
                action: "closed",
                organizationId,
            });
            return;
        }

        const { pull_request: pr, repository: repo } = parsed.data;
        await this.teardown({
            repoFullName: repo.full_name,
            prNumber: pr.number,
            organizationId,
            githubRepositoryId: repo.id,
            headSha: pr.head.sha,
            headRef: pr.head.ref,
        });
    }

    /**
     * Deploys an Application's main branch into environment 0 (GitHub PR
     * numbers start at 1, so 0 is the stable non-PR environment). Resolves the
     * branch head on GitHub, then starts the same deploy workflow.
     */
    async deployMainBranch(applicationId: string, callerOrgId: string | undefined): Promise<MainBranchDeployResult> {
        this.logger.info("Triggering main-branch preview deploy", { applicationId });

        const application = await this.db.application.findFirst({
            where: {
                id: applicationId,
                ...(callerOrgId != null ? { organizationId: callerOrgId } : {}),
            },
            select: {
                id: true,
                disabled: true,
                organizationId: true,
                githubRepositoryId: true,
                mainBranch: { select: { name: true } },
                mainBranchInfo: { select: { githubRef: true } },
            },
        });

        if (application == null) throw new NotFoundError("Application not found");
        if (application.disabled) throw new ConflictError("Application is disabled and cannot be deployed");
        if (application.githubRepositoryId == null) {
            throw new ConflictError("Application is not linked to a GitHub repository");
        }

        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId: application.organizationId },
            select: { status: true },
        });
        if (installation == null) throw new ConflictError("Organization has no GitHub installation");
        if (installation.status !== "active") {
            throw new ConflictError(`GitHub installation is ${installation.status}`);
        }

        const repo = await this.githubInstallationService
            .getRepository(application.organizationId, application.githubRepositoryId)
            .catch((err: unknown) => {
                if (errorStatus(err) === 404) return undefined;
                throw err;
            });
        if (repo == null) throw new NotFoundError("Linked GitHub repository not found or inaccessible");

        const mainRef = application.mainBranchInfo?.githubRef ?? application.mainBranch?.name ?? repo.defaultBranch;
        const branchName = normalizeBranchName(mainRef);
        const headSha = await this.githubInstallationService
            .getBranchHead(application.organizationId, application.githubRepositoryId, branchName)
            .catch((err: unknown) => {
                if (errorStatus(err) === 404) return undefined;
                throw err;
            });
        if (headSha == null) throw new NotFoundError(`Main branch ref '${mainRef}' not found on GitHub`);

        await this.deploy(
            {
                repoFullName: repo.fullName,
                prNumber: MAIN_BRANCH_ENVIRONMENT_NUMBER,
                organizationId: application.organizationId,
                githubRepositoryId: application.githubRepositoryId,
                headSha,
                headRef: branchName,
                baseSha: headSha,
                baseRef: branchName,
                cloneUrl: `https://github.com/${repo.fullName}.git`,
            },
            "synchronize",
        );

        return {
            applicationId: application.id,
            repoFullName: repo.fullName,
            branch: branchName,
            headSha,
            prNumber: MAIN_BRANCH_ENVIRONMENT_NUMBER,
        };
    }

    /**
     * Re-runs the deploy at the environment's current head SHA, pinning the
     * config revision it was originally deployed with so the redeploy
     * reproduces the same topology. `callerOrgId` narrows to the caller's own
     * environments; pass undefined for admin/service callers.
     */
    async redeploy(repoFullName: string, prNumber: number, callerOrgId?: string): Promise<void> {
        this.logger.info("Triggering preview redeploy", { repo: repoFullName, pr: prNumber });

        const environment = await this.db.previewkitEnvironment.findFirst({
            where: {
                repoFullName,
                prNumber,
                ...(callerOrgId != null ? { organizationId: callerOrgId } : {}),
            },
            select: {
                headSha: true,
                headRef: true,
                organizationId: true,
                githubRepositoryId: true,
                status: true,
                configRevisionId: true,
            },
        });

        if (environment == null) throw new NotFoundError("Environment not found");
        if (environment.status === "torn_down") {
            throw new ConflictError("Environment has been torn down and cannot be redeployed");
        }
        if (environment.githubRepositoryId == null) {
            throw new ConflictError("Environment predates redeploy support and cannot be redeployed");
        }

        await this.deploy(
            {
                repoFullName,
                prNumber,
                organizationId: environment.organizationId,
                githubRepositoryId: environment.githubRepositoryId,
                headSha: environment.headSha,
                headRef: environment.headRef,
                cloneUrl: "",
            },
            "synchronize",
            environment.configRevisionId ?? undefined,
        );
    }
}

function normalizeBranchName(ref: string): string {
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/** Status code carried by Octokit request errors (404 = repo/branch not visible to the installation). */
function errorStatus(error: unknown): number | undefined {
    if (error instanceof Error && "status" in error) {
        const status: unknown = error.status;
        return typeof status === "number" ? status : undefined;
    }
    return undefined;
}
