import type { PrismaClient } from "@autonoma/db";
import { ConflictError, NotFoundError } from "@autonoma/errors";
import type {
    PreviewRedeployAppMode,
    TriggerPreviewDeployParams,
    TriggerPreviewRedeployAppParams,
    TriggerPreviewTeardownParams,
} from "@autonoma/types";
import { z } from "zod";
import type { GitHubInstallationService } from "../github/github-installation.service";
import { upsertPrBranch } from "../routes/branches/upsert-pr-branch";
import { Service } from "../routes/service";

export const MAIN_BRANCH_ENVIRONMENT_NUMBER = 0;

export type PreviewDeployAction = "opened" | "synchronize" | "reopened" | "ready_for_review";

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
    /** The autonoma Branch this environment deploys (PR feature branch, or main branch for env 0); forwarded to the runner to link the env row. */
    branchId?: string | undefined;
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

/** A push webhook resolved to the main-branch environment it updates. */
interface MainBranchPushTarget {
    repoFullName: string;
    branch: string;
    headSha: string;
    githubRepositoryId: number;
    cloneUrl: string;
}

/** The two GitHub reads the main-branch preflight needs. */
export type PreviewkitGitHubReader = Pick<GitHubInstallationService, "getRepository" | "getBranchHead">;

/** The pull_request webhook fields the preview lifecycle needs. */
const pullRequestWebhookSchema = z.object({
    pull_request: z.object({
        number: z.number().int().positive(),
        draft: z.boolean().optional(),
        head: z.object({ sha: z.string(), ref: z.string() }),
        base: z.object({ sha: z.string(), ref: z.string() }),
    }),
    repository: z.object({
        id: z.number().int().positive(),
        full_name: z.string(),
        clone_url: z.string(),
    }),
});

/** The push webhook fields the main-branch environment update needs. */
const pushWebhookSchema = z.object({
    ref: z.string(),
    after: z.string(),
    deleted: z.boolean().optional(),
    repository: z.object({
        id: z.number().int().positive(),
        full_name: z.string(),
        clone_url: z.string(),
    }),
});

/** `after` on a branch-deletion push (40 zeros for SHA-1 repos, 64 for SHA-256). */
const ZERO_SHA = /^0+$/;

/** Minimal shape for reading app names from a stored resolved config (fallback when app instance rows are absent). */
const resolvedConfigAppsSchema = z.object({ apps: z.array(z.object({ name: z.string() })) });

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
        private readonly triggerRedeployApp: (params: TriggerPreviewRedeployAppParams) => Promise<void>,
    ) {
        super();
    }

    /** Starts a deploy workflow for a PR. */
    async deploy(request: PreviewkitDeployRequest, action: PreviewDeployAction = "opened"): Promise<void> {
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
                branchId: request.branchId,
            },
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

        const app = await this.db.application.findUnique({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId: repo.id } },
            select: { onboardingState: { select: { previewEnvironmentMode: true } } },
        });
        if (app?.onboardingState?.previewEnvironmentMode === "existing_deploys") {
            this.logger.info("Skipping PreviewKit deploy: application uses existing_deploys (e.g. Vercel)", {
                action,
                organizationId,
                repo: repo.full_name,
                pr: pr.number,
            });
            return;
        }

        if (pr.draft === true && !(await this.isDraftBuildEnabled(organizationId))) {
            this.logger.info("Skipping preview deploy for draft PR: previewkitBuildDraft disabled", {
                action,
                organizationId,
                repo: repo.full_name,
                pr: pr.number,
            });
            return;
        }

        const branchId = await this.resolveBranchIdForPr(organizationId, repo.id, pr.number, pr.head.ref);

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
                branchId,
            },
            action,
        );
    }

    /**
     * Eagerly find-or-create the autonoma Branch a PR maps to, so a preview environment is linked to its branch
     * before any diff runs. Best-effort: a repo with no onboarded Application (or any transient failure) yields
     * `undefined` and the deploy proceeds unlinked - branch creation then falls back to the lazy diff-trigger
     * path. Never throws, so it cannot block a preview deploy.
     */
    private async resolveBranchIdForPr(
        organizationId: string,
        githubRepositoryId: number,
        prNumber: number,
        headRef: string,
    ): Promise<string | undefined> {
        try {
            const application = await this.db.application.findUnique({
                where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId } },
                select: { id: true },
            });
            if (application == null) {
                this.logger.info("Repo not linked to an Application; skipping eager branch creation", {
                    organizationId,
                    extra: { githubRepositoryId, prNumber },
                });
                return undefined;
            }

            const branch = await upsertPrBranch({
                db: this.db,
                applicationId: application.id,
                organizationId,
                prNumber,
                name: headRef,
            });
            return branch.id;
        } catch (error) {
            this.logger.warn("Failed to eagerly create branch for preview deploy; proceeding unlinked", {
                organizationId,
                extra: { githubRepositoryId, prNumber, error: String(error) },
            });
            return undefined;
        }
    }

    /**
     * Whether the organization opted into building previews for draft PRs.
     * Defaults to false when no settings row exists, so draft PRs are skipped
     * unless an org explicitly turns `previewkitBuildDraft` on.
     */
    private async isDraftBuildEnabled(organizationId: string): Promise<boolean> {
        const settings = await this.db.organizationSettings.findUnique({
            where: { organizationId },
            select: { previewkitBuildDraft: true },
        });
        return settings?.previewkitBuildDraft ?? false;
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

        const app = await this.db.application.findUnique({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId: repo.id } },
            select: { onboardingState: { select: { previewEnvironmentMode: true } } },
        });
        if (app?.onboardingState?.previewEnvironmentMode === "existing_deploys") {
            this.logger.info("Skipping PreviewKit teardown: application uses existing_deploys (e.g. Vercel)", {
                organizationId,
                repo: repo.full_name,
                pr: pr.number,
            });
            return;
        }

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
                mainBranchId: true,
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
                branchId: application.mainBranchId ?? undefined,
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
     * True when a `push` webhook would update a main-branch environment. The
     * webhook router checks this before recording the delivery - push fires
     * for every branch of every connected repo, and the ones that don't touch
     * a main-branch environment are noise.
     */
    async pushTargetsMainBranchEnvironment(organizationId: string, payload: Record<string, unknown>): Promise<boolean> {
        const target = await this.resolveMainBranchPushTarget(organizationId, payload);
        return target != null;
    }

    /**
     * Deploy entry point for `push` webhooks. A push to the branch a live
     * main-branch environment tracks redeploys environment 0 at the pushed
     * head - the same update a PR environment gets from `synchronize`. Any
     * other push (different branch, no environment, torn down, branch
     * deletion, tag) is skipped.
     */
    async deployMainBranchFromPushWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        const target = await this.resolveMainBranchPushTarget(organizationId, payload);
        if (target == null) return;

        this.logger.info("Push updates main-branch environment", {
            repo: target.repoFullName,
            branch: target.branch,
            sha: target.headSha,
        });

        const branchId = await this.resolveMainBranchId(organizationId, target.githubRepositoryId);

        await this.deploy(
            {
                repoFullName: target.repoFullName,
                prNumber: MAIN_BRANCH_ENVIRONMENT_NUMBER,
                organizationId,
                githubRepositoryId: target.githubRepositoryId,
                headSha: target.headSha,
                headRef: target.branch,
                baseSha: target.headSha,
                baseRef: target.branch,
                cloneUrl: target.cloneUrl,
                branchId,
            },
            "synchronize",
        );
    }

    /**
     * Resolve the Application's main Branch id so a main-branch preview environment (PR 0) is linked to it, the
     * counterpart of `resolveBranchIdForPr` for the non-PR environment. Best-effort: an un-onboarded repo (or a
     * transient failure) yields `undefined` and the deploy proceeds unlinked. Never throws.
     */
    private async resolveMainBranchId(organizationId: string, githubRepositoryId: number): Promise<string | undefined> {
        try {
            const application = await this.db.application.findUnique({
                where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId } },
                select: { mainBranchId: true },
            });
            if (application?.mainBranchId == null) {
                this.logger.info("No main branch for repo; deploying main-branch env unlinked", {
                    organizationId,
                    extra: { githubRepositoryId },
                });
                return undefined;
            }
            return application.mainBranchId;
        } catch (error) {
            this.logger.warn("Failed to resolve main branch for preview deploy; proceeding unlinked", {
                organizationId,
                extra: { githubRepositoryId, error: String(error) },
            });
            return undefined;
        }
    }

    /**
     * Resolves a push webhook to the main-branch environment it updates, or
     * undefined when the push is irrelevant: a tag push, a branch deletion, a
     * branch the environment doesn't track, or no live environment 0 at all.
     */
    private async resolveMainBranchPushTarget(
        organizationId: string,
        payload: Record<string, unknown>,
    ): Promise<MainBranchPushTarget | undefined> {
        const parsed = pushWebhookSchema.safeParse(payload);
        if (!parsed.success) {
            this.logger.warn("Push webhook missing ref, after or repository payload", { organizationId });
            return undefined;
        }

        const { ref, after, deleted, repository } = parsed.data;
        if (!ref.startsWith("refs/heads/")) return undefined;
        if (deleted === true || ZERO_SHA.test(after)) return undefined;

        const branch = normalizeBranchName(ref);
        const environment = await this.db.previewkitEnvironment.findFirst({
            where: {
                repoFullName: repository.full_name,
                prNumber: MAIN_BRANCH_ENVIRONMENT_NUMBER,
                organizationId,
                status: { not: "torn_down" },
            },
            select: { headRef: true },
        });
        if (environment == null) return undefined;
        if (environment.headRef !== branch) {
            this.logger.debug("Push branch does not match main-branch environment", {
                repo: repository.full_name,
                pushedBranch: branch,
                environmentBranch: environment.headRef,
            });
            return undefined;
        }

        return {
            repoFullName: repository.full_name,
            branch,
            headSha: after,
            githubRepositoryId: repository.id,
            cloneUrl: repository.clone_url,
        };
    }

    /**
     * Re-runs the deploy at the environment's current head SHA. Config is
     * latest-only, so the redeploy resolves the Application's current config
     * (not the one the environment was originally deployed with). `callerOrgId`
     * narrows to the caller's own environments; pass undefined for
     * admin/service callers.
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
        );
    }

    /**
     * Redeploys a SINGLE app within a live environment. `mode` "rebuild"
     * rebuilds that app's image at the environment's current head SHA (against
     * the Application's current config - config is latest-only) and redeploys
     * only it; "restart" re-rolls its pods using the running image. Siblings are
     * left untouched either way. `callerOrgId` narrows to the caller's own
     * environments; pass undefined for admin/service callers.
     */
    async redeployApp(
        repoFullName: string,
        prNumber: number,
        appName: string,
        mode: PreviewRedeployAppMode,
        callerOrgId?: string,
    ): Promise<void> {
        this.logger.info("Triggering per-app preview redeploy", {
            repo: repoFullName,
            pr: prNumber,
            app: appName,
            mode,
        });

        const environment = await this.db.previewkitEnvironment.findFirst({
            where: {
                repoFullName,
                prNumber,
                ...(callerOrgId != null ? { organizationId: callerOrgId } : {}),
            },
            select: {
                namespace: true,
                headSha: true,
                headRef: true,
                organizationId: true,
                githubRepositoryId: true,
                status: true,
                resolvedConfig: true,
                appInstances: { select: { appName: true } },
            },
        });

        if (environment == null) throw new NotFoundError("Environment not found");
        if (environment.status === "torn_down") {
            throw new ConflictError("Environment has been torn down and cannot be redeployed");
        }
        if (environment.githubRepositoryId == null) {
            throw new ConflictError("Environment predates redeploy support and cannot be redeployed");
        }
        if (!environmentHasApp(environment.appInstances, environment.resolvedConfig, appName)) {
            throw new NotFoundError(`App "${appName}" not found in this environment`);
        }

        await this.triggerRedeployApp({
            event: {
                action: "synchronize",
                prNumber,
                repoFullName,
                organizationId: environment.organizationId,
                githubRepositoryId: environment.githubRepositoryId,
                headSha: environment.headSha,
                headRef: environment.headRef,
                baseSha: "",
                baseRef: "",
                cloneUrl: "",
            },
            namespace: environment.namespace,
            appName,
            mode,
        });
    }
}

/**
 * True when the environment declares `appName` - checked against its per-app
 * instance rows first (authoritative), falling back to the stored resolved
 * config for environments that predate instance rows.
 */
function environmentHasApp(
    appInstances: Array<{ appName: string }>,
    resolvedConfig: unknown,
    appName: string,
): boolean {
    if (appInstances.some((instance) => instance.appName === appName)) return true;
    const parsed = resolvedConfigAppsSchema.safeParse(resolvedConfig);
    return parsed.success && parsed.data.apps.some((app) => app.name === appName);
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
