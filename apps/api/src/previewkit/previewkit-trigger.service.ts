import type { BillingService } from "@autonoma/billing";
import type { Prisma, PreviewkitStatus, PrismaClient } from "@autonoma/db";
import { ConflictError, InsufficientPreviewCreditsError, NotFoundError } from "@autonoma/errors";
import { autonomaHostsPreviews } from "@autonoma/test-updates";
import type { PreviewRedeployAppMode, PreviewTeardownTarget, TriggerPreviewRedeployAppParams } from "@autonoma/types";
import type { AnalysisRunWorkflowInput, PreviewBuildWorkflowInput } from "@autonoma/workflow";
import { z } from "zod";
import { env } from "../env";
import { githubErrorStatus, normalizeBranchName } from "../github/git-ref";
import type { GitHubInstallationService } from "../github/github-installation.service";
import { upsertPrBranch } from "../routes/branches/upsert-pr-branch";
import { Service } from "../routes/service";

/** Posted to the PR when a deploy/redeploy is declined for a zero credit balance. */
const INSUFFICIENT_CREDITS_COMMENT =
    "This organization is out of credits, so this preview environment could not be deployed. Add credits to resume previews.";

export const MAIN_BRANCH_ENVIRONMENT_NUMBER = 0;

export type PreviewDeployAction = "opened" | "synchronize" | "reopened" | "ready_for_review";

export interface PreviewkitRunRequest {
    repoFullName: string;
    prNumber: number;
    organizationId: string;
    githubRepositoryId: number;
    headSha: string;
    headRef: string;
    /** The commit a run diffs against, when the trigger read one from GitHub. */
    baseSha?: string | undefined;
    /** The autonoma Branch this environment deploys (PR feature branch, or main branch for env 0). */
    branchId?: string | undefined;
}

export interface PreviewkitTeardownRequest {
    repoFullName: string;
    prNumber: number;
    organizationId: string;
    /** Optional; the teardown activity falls back to the environment row's stored sha. */
    headSha?: string | undefined;
}

/**
 * How a caller addresses one preview environment. Both forms are unique keys, so a caller passes whichever it
 * already holds - the id from an admin or app-scoped view, the pair from a webhook or the public HTTP surface.
 */
export type PreviewEnvironmentKey = { environmentId: string } | { repoFullName: string; prNumber: number };

/** Narrows a lookup to what the caller may reach. Both absent for admin and service callers. */
export interface PreviewEnvironmentScope {
    organizationId?: string | undefined;
    /** Ties the environment to one Application's linked repository. */
    githubRepositoryId?: number | undefined;
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
}

/** The GitHub reads the main-branch preflight and redeploy head-resolution need, plus posting the credits-blocked comment. */
export type PreviewkitGitHubReader = Pick<
    GitHubInstallationService,
    "getRepository" | "getBranchHead" | "getPullRequest" | "postComment"
>;

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
 * Preflight, then a fire-and-forget trigger. A run started BY GITHUB owns everything downstream, including
 * whether the commit warrants a build at all; an explicit deploy request builds directly and cannot be refused
 * (see {@link PreviewkitTriggerService.startExplicitBuild}), as do teardown and per-app redeploy, which have
 * nothing to decide.
 */
export class PreviewkitTriggerService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly githubInstallationService: PreviewkitGitHubReader,
        private readonly billingService: Pick<BillingService, "checkPreviewDeployCreditsGate">,
        private readonly startAnalysisRun: (input: AnalysisRunWorkflowInput) => Promise<void>,
        private readonly startPreviewBuild: (input: PreviewBuildWorkflowInput) => Promise<void>,
        private readonly triggerTeardown: (target: PreviewTeardownTarget) => Promise<void>,
        private readonly triggerRedeployApp: (params: TriggerPreviewRedeployAppParams) => Promise<void>,
    ) {
        super();
    }

    /** Credits are checked HERE so every caller surfaces the same refusal. */
    async startRun(request: PreviewkitRunRequest, action: PreviewDeployAction = "opened"): Promise<void> {
        this.logger.info("Starting a preview run", {
            repo: request.repoFullName,
            pr: request.prNumber,
            action,
        });

        await this.assertDeployCreditsAvailable(request.organizationId, request.repoFullName, request.prNumber);

        if (request.branchId == null) {
            await this.startBuildWithoutRun(request);
            return;
        }

        await this.startAnalysisRun({
            branchId: request.branchId,
            headSha: request.headSha,
            baseSha: request.baseSha,
        });
    }

    /** No Application, so no run to open - but lack of analysis wiring must not cost a customer their preview. */
    private async startBuildWithoutRun(request: PreviewkitRunRequest): Promise<void> {
        this.logger.info("Starting a preview build with no analysis run: no branch resolved for this repo", {
            repo: request.repoFullName,
            pr: request.prNumber,
        });
        await this.startPreviewBuild({
            target: {
                repoFullName: request.repoFullName,
                prNumber: request.prNumber,
                organizationId: request.organizationId,
                githubRepositoryId: request.githubRepositoryId,
                headSha: request.headSha,
                headRef: request.headRef,
            },
            reason: "branch_not_resolvable",
        });
    }

    /**
     * The build behind every explicit "deploy this branch" - a person in the UI, an agent over MCP, an admin.
     * Such a request asks for the preview itself rather than a verdict on the commit, so no analysis stands in
     * front of it: impact analysis on a branch with no test suite yet selects nothing and would refuse the build,
     * which is precisely the state an application is in while it is being set up.
     */
    private async startExplicitBuild(request: PreviewkitRunRequest): Promise<void> {
        this.logger.info("Starting an explicitly requested preview build", {
            organizationId: request.organizationId,
            repo: request.repoFullName,
            pr: request.prNumber,
        });

        await this.assertDeployCreditsAvailable(request.organizationId, request.repoFullName, request.prNumber);

        await this.startPreviewBuild({
            target: {
                repoFullName: request.repoFullName,
                prNumber: request.prNumber,
                organizationId: request.organizationId,
                githubRepositoryId: request.githubRepositoryId,
                headSha: request.headSha,
                headRef: request.headRef,
                branchId: request.branchId,
            },
            reason: "force_build",
            branchId: request.branchId,
        });
    }

    /** Launches a teardown Job for a PR (SIGTERMs an in-flight deploy first via the shared per-environment key). */
    async teardown(request: PreviewkitTeardownRequest): Promise<void> {
        this.logger.info("Triggering preview teardown", { repo: request.repoFullName, pr: request.prNumber });

        await this.triggerTeardown({
            repoFullName: request.repoFullName,
            prNumber: request.prNumber,
            organizationId: request.organizationId,
            headSha: request.headSha,
        });
    }

    /** An unparseable payload is skipped, not retried: GitHub redelivers non-2xx, and malformed will not improve. */
    async startRunFromPullRequestWebhook(
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

        if (await this.usesExternalDeploys(organizationId, repo.id)) {
            this.logger.info("Skipping the preview run: the customer deploys this app's previews", {
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

        if (await this.isActivationGated(organizationId)) {
            this.logger.info(
                "Activation: skipping the automatic preview run; a run starts only on an explicit request",
                {
                    action,
                    organizationId,
                    repo: repo.full_name,
                    pr: pr.number,
                },
            );
            return;
        }

        const branchId = await this.resolveBranchIdForPr(organizationId, repo.id, pr.number, pr.head.ref);

        await this.startRun(
            {
                repoFullName: repo.full_name,
                prNumber: pr.number,
                organizationId,
                githubRepositoryId: repo.id,
                headSha: pr.head.sha,
                headRef: pr.head.ref,
                baseSha: pr.base.sha,
                branchId,
            },
            action,
        );
    }

    /**
     * Find-or-create the Branch a PR maps to, before any diff runs. Never throws: an un-onboarded repo or a
     * transient failure yields `undefined` and the run proceeds unlinked, rather than costing a preview.
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
     * Declines a new run (never teardown) on a zero balance. Dual-switched - global and per-org, either off is a
     * no-op - so enforcement rolls out per org. Comments on the PR before throwing, so every caller explains itself.
     */
    private async assertDeployCreditsAvailable(
        organizationId: string,
        repoFullName: string,
        prNumber: number,
    ): Promise<void> {
        if (!env.PREVIEWKIT_BILLING_ENABLED) return;

        const settings = await this.db.organizationSettings.findUnique({
            where: { organizationId },
            select: { previewkitBillingEnabled: true },
        });
        if (settings?.previewkitBillingEnabled !== true) return;

        const gate = await this.billingService.checkPreviewDeployCreditsGate(organizationId);
        if (gate.allowed) return;

        this.logger.info("Blocking preview deploy: organization is out of credits", {
            organizationId,
            repo: repoFullName,
            pr: prNumber,
        });

        await this.githubInstallationService
            .postComment(organizationId, repoFullName, prNumber, INSUFFICIENT_CREDITS_COMMENT)
            .catch((error: unknown) => {
                this.logger.warn("Failed to post insufficient-credits PR comment", {
                    organizationId,
                    repo: repoFullName,
                    pr: prNumber,
                    error: String(error),
                });
            });

        throw new InsufficientPreviewCreditsError();
    }

    /** Defaults to false, so drafts are skipped unless an org opts in. */
    private async isDraftBuildEnabled(organizationId: string): Promise<boolean> {
        const settings = await this.db.organizationSettings.findUnique({
            where: { organizationId },
            select: { previewkitBuildDraft: true },
        });
        return settings?.previewkitBuildDraft ?? false;
    }

    /**
     * Under activation no automatic run starts - not the analysis, nor the build its verdict would warrant. An
     * explicit request still runs, which is why this is asked at the one entry point meaning "GitHub pushed".
     */
    private async isActivationGated(organizationId: string): Promise<boolean> {
        const settings = await this.db.organizationSettings.findUnique({
            where: { organizationId },
            select: { activationEnabled: true },
        });
        return settings?.activationEnabled === true;
    }

    /**
     * Whether the customer deploys this repo's previews themselves (Vercel and the like). Only the webhook entries
     * need to ask - every other path is reached through an environment Autonoma already hosts.
     *
     * An Application that has made no choice yet counts as customer-deployed, matching the run's own
     * `resolvePreviewTarget`: a webhook cannot know a preview URL, so opening a run here would test a preview
     * nobody recorded. No Application at all is different - there is no onboarding choice to disagree with, and
     * `startRun` already falls back to an unlinked best-effort build for that case via `startBuildWithoutRun`.
     */
    private async usesExternalDeploys(organizationId: string, githubRepositoryId: number): Promise<boolean> {
        const application = await this.db.application.findUnique({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId } },
            select: { onboardingState: { select: { previewEnvironmentMode: true } } },
        });
        if (application == null) return false;
        return !autonomaHostsPreviews(application.onboardingState?.previewEnvironmentMode);
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

        if (await this.usesExternalDeploys(organizationId, repo.id)) {
            this.logger.info("Skipping the preview teardown: the customer deploys this app's previews", {
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
            headSha: pr.head.sha,
        });
    }

    /**
     * Deploys the main branch into environment 0, resolving its head on GitHub first. An undefined `callerOrgId`
     * reaches every organization's applications, and only the admin tRPC surface passes it.
     */
    async startMainBranchRun(applicationId: string, callerOrgId: string | undefined): Promise<MainBranchDeployResult> {
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
                if (githubErrorStatus(err) === 404) return undefined;
                throw err;
            });
        if (repo == null) throw new NotFoundError("Linked GitHub repository not found or inaccessible");

        const githubRepositoryId = application.githubRepositoryId;
        // The repo default applies only when nothing is configured, never as a silent fallback for a ref that has
        // gone missing - a chosen branch that no longer exists errors below.
        const deployRef = application.mainBranchInfo?.githubRef ?? application.mainBranch?.name ?? repo.defaultBranch;
        const branchName = normalizeBranchName(deployRef);
        const headSha = await this.githubInstallationService
            .getBranchHead(application.organizationId, githubRepositoryId, branchName)
            .catch((err: unknown) => {
                if (githubErrorStatus(err) === 404) return undefined;
                throw err;
            });

        if (headSha == null) throw new NotFoundError(`Deploy branch '${branchName}' not found on GitHub`);

        await this.startRun(
            {
                repoFullName: repo.fullName,
                prNumber: MAIN_BRANCH_ENVIRONMENT_NUMBER,
                organizationId: application.organizationId,
                githubRepositoryId: application.githubRepositoryId,
                headSha,
                headRef: branchName,
                baseSha: headSha,
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
     * Environment 0 has no pull request, so `push` is the only signal that its branch moved - and it fires for
     * every branch of every connected repo, which is why most deliveries here resolve to nothing.
     */
    async startMainBranchRunFromPushWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        const target = await this.resolveMainBranchPushTarget(organizationId, payload);
        if (target == null) {
            this.logger.info("Push does not update a main-branch preview environment", { organizationId });
            return;
        }

        this.logger.info("Push updates main-branch environment", {
            repo: target.repoFullName,
            branch: target.branch,
            sha: target.headSha,
        });

        const branchId = await this.resolveMainBranchId(organizationId, target.githubRepositoryId);

        await this.startRun(
            {
                repoFullName: target.repoFullName,
                prNumber: MAIN_BRANCH_ENVIRONMENT_NUMBER,
                organizationId,
                githubRepositoryId: target.githubRepositoryId,
                headSha: target.headSha,
                headRef: target.branch,
                baseSha: target.headSha,
                branchId,
            },
            "synchronize",
        );
    }

    /** `resolveBranchIdForPr` for environment 0. Never throws; an un-onboarded repo runs unlinked. */
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

    /** Undefined when the push is irrelevant: a tag, a deletion, an untracked branch, or no live environment 0. */
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
        };
    }

    /**
     * Re-runs at the newest head GitHub reports, so a redeploy picks up commits pushed since the last webhook.
     * Config is latest-only: the redeploy resolves the Application's current config, not the deployed one. An
     * environment that was never built is deployed for the first time rather than reported missing.
     */
    async startRunForRedeploy(key: PreviewEnvironmentKey, scope: PreviewEnvironmentScope = {}): Promise<void> {
        const found = await this.db.previewkitEnvironment.findFirst({
            where: environmentWhere(key, scope),
            select: {
                repoFullName: true,
                prNumber: true,
                headSha: true,
                headRef: true,
                organizationId: true,
                githubRepositoryId: true,
                status: true,
            },
        });

        if (found == null) {
            await this.firstDeployForMissingEnvironment(key, scope);
            return;
        }

        const { environment, githubRepositoryId } = requireRedeployable(found);

        const { repoFullName, prNumber } = environment;
        this.logger.info("Triggering preview redeploy", { repo: repoFullName, pr: prNumber });

        const { headSha, headRef } = await this.resolveLatestHead(
            environment.organizationId,
            githubRepositoryId,
            repoFullName,
            prNumber,
            { headSha: environment.headSha, headRef: environment.headRef },
        );

        await this.startExplicitBuild({
            repoFullName,
            prNumber,
            organizationId: environment.organizationId,
            githubRepositoryId,
            headSha,
            headRef,
        });
    }

    /**
     * A redeploy of an environment that was never built. The caller still asked for this preview, so it is
     * deployed for the first time instead of being told the environment is missing: a branch impact analysis
     * declined to build has no environment row, and asking by hand is how someone gets out of exactly that.
     *
     * Only a repo-keyed request can be recovered - an environment id names a row, and a row that is not there
     * names nothing - and only for a caller whose organization is known, since the deploy runs as that org.
     */
    private async firstDeployForMissingEnvironment(
        key: PreviewEnvironmentKey,
        scope: PreviewEnvironmentScope,
    ): Promise<void> {
        if ("environmentId" in key) throw new NotFoundError("Preview environment not found");

        const { repoFullName, prNumber } = key;
        const organizationId = scope.organizationId;
        if (organizationId == null) throw new NotFoundError("Preview environment not found");

        const githubRepositoryId =
            scope.githubRepositoryId ?? (await this.resolveRepositoryId(organizationId, repoFullName));
        if (githubRepositoryId == null) {
            throw new NotFoundError(
                `No preview environment for ${repoFullName}#${prNumber}, and this organization has no environment for ${repoFullName} to deploy from`,
            );
        }

        this.logger.info("No environment to redeploy; deploying this preview for the first time", {
            organizationId,
            repo: repoFullName,
            pr: prNumber,
        });

        if (prNumber !== MAIN_BRANCH_ENVIRONMENT_NUMBER) {
            await this.startRunForPullRequest(organizationId, githubRepositoryId, prNumber);
            return;
        }

        // Environment 0 has no pull request to read a head from; the Application's stored deploy ref is the only
        // thing that says which branch it deploys, so the main-branch entry point owns this case.
        const application = await this.db.application.findUnique({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId } },
            select: { id: true },
        });
        if (application == null) {
            throw new NotFoundError(`No application deploys ${repoFullName}, so its base preview cannot be deployed`);
        }
        await this.startMainBranchRun(application.id, organizationId);
    }

    /**
     * The repository id behind a repo full name, read from any environment the organization already has for that
     * repository - the id belongs to the repo, not to one environment. Undefined when it has none, where nothing
     * here can name a repository on GitHub with any confidence.
     */
    private async resolveRepositoryId(organizationId: string, repoFullName: string): Promise<number | undefined> {
        const known = await this.db.previewkitEnvironment.findFirst({
            where: { organizationId, repoFullName, githubRepositoryId: { not: null } },
            select: { githubRepositoryId: true },
            orderBy: { createdAt: "desc" },
        });
        return known?.githubRepositoryId ?? undefined;
    }

    /**
     * A first deploy for an open PR with no environment yet, at the head GitHub currently reports. Deploying a
     * draft here is deliberate - an explicit request, unlike the webhook's noise-avoidance skip - and so is
     * building without opening an analysis run: the request is for the preview, and a selection that comes back
     * empty must not be able to take it away.
     */
    async startRunForPullRequest(organizationId: string, githubRepositoryId: number, prNumber: number): Promise<void> {
        this.logger.info("Triggering first preview deploy for a PR without an environment", {
            organizationId,
            pr: prNumber,
            extra: { githubRepositoryId },
        });

        const [repo, pr] = await Promise.all([
            this.githubInstallationService.getRepository(organizationId, githubRepositoryId),
            this.githubInstallationService.getPullRequest(organizationId, githubRepositoryId, prNumber),
        ]);
        if (pr.state !== "open") {
            throw new ConflictError(`Pull request #${prNumber} is ${pr.state} and cannot be deployed`);
        }

        const branchId = await this.resolveBranchIdForPr(organizationId, githubRepositoryId, prNumber, pr.headRef);

        await this.startExplicitBuild({
            repoFullName: repo.fullName,
            prNumber,
            organizationId,
            githubRepositoryId,
            headSha: pr.headSha,
            headRef: pr.headRef,
            branchId,
        });
    }

    /**
     * A PR environment follows its PR's head; environment 0 follows its tracked branch. Any GitHub failure falls
     * back to the stored head, so a redeploy always works.
     */
    private async resolveLatestHead(
        organizationId: string,
        githubRepositoryId: number,
        repoFullName: string,
        prNumber: number,
        stored: { headSha: string; headRef: string },
    ): Promise<{ headSha: string; headRef: string }> {
        try {
            if (prNumber === MAIN_BRANCH_ENVIRONMENT_NUMBER) {
                const headSha = await this.githubInstallationService.getBranchHead(
                    organizationId,
                    githubRepositoryId,
                    stored.headRef,
                );
                return { headSha, headRef: stored.headRef };
            }

            const pr = await this.githubInstallationService.getPullRequest(
                organizationId,
                githubRepositoryId,
                prNumber,
            );
            return { headSha: pr.headSha, headRef: pr.headRef };
        } catch (error) {
            this.logger.warn("Failed to resolve latest head for redeploy; using the stored head", {
                repo: repoFullName,
                pr: prNumber,
                extra: { storedHeadSha: stored.headSha, error: String(error) },
            });
            return stored;
        }
    }

    /**
     * One app within a live environment: "rebuild" rebuilds its image at the environment's head, "restart" re-rolls
     * its pods on the running image. Siblings are untouched either way.
     */
    async redeployApp(
        key: PreviewEnvironmentKey,
        appName: string,
        mode: PreviewRedeployAppMode,
        scope: PreviewEnvironmentScope = {},
    ): Promise<void> {
        const { environment, githubRepositoryId } = requireRedeployable(
            await this.db.previewkitEnvironment.findFirst({
                where: environmentWhere(key, scope),
                select: {
                    namespace: true,
                    repoFullName: true,
                    prNumber: true,
                    headSha: true,
                    headRef: true,
                    organizationId: true,
                    githubRepositoryId: true,
                    status: true,
                    resolvedConfig: true,
                    appInstances: { select: { appName: true } },
                },
            }),
        );

        if (!environmentHasApp(environment.appInstances, environment.resolvedConfig, appName)) {
            throw new NotFoundError(`App "${appName}" not found in this environment`);
        }

        const { repoFullName, prNumber } = environment;
        this.logger.info("Triggering per-app preview redeploy", {
            repo: repoFullName,
            pr: prNumber,
            app: appName,
            mode,
        });

        await this.assertDeployCreditsAvailable(environment.organizationId, repoFullName, prNumber);

        await this.triggerRedeployApp({
            target: {
                repoFullName,
                prNumber,
                organizationId: environment.organizationId,
                githubRepositoryId,
                headSha: environment.headSha,
                headRef: environment.headRef,
            },
            namespace: environment.namespace,
            appName,
            mode,
        });
    }
}

/**
 * The `where` for a redeploy lookup. Both keys are unique, so a caller addresses the environment with whichever it
 * holds rather than translating one into the other; the scope narrows to what that caller is allowed to reach.
 */
function environmentWhere(
    key: PreviewEnvironmentKey,
    scope: PreviewEnvironmentScope,
): Prisma.PreviewkitEnvironmentWhereInput {
    if ("environmentId" in key) {
        return {
            id: key.environmentId,
            organizationId: scope.organizationId,
            githubRepositoryId: scope.githubRepositoryId,
        };
    }
    return {
        repoFullName: key.repoFullName,
        prNumber: key.prNumber,
        organizationId: scope.organizationId,
        githubRepositoryId: scope.githubRepositoryId,
    };
}

/**
 * The preflight both redeploy entry points share. Hands back the repository id separately because the schema
 * allows it to be absent, and nothing can be launched without one.
 */
function requireRedeployable<T extends RedeployableEnvironment>(
    environment: T | null,
): { environment: T; githubRepositoryId: number } {
    if (environment == null) throw new NotFoundError("Preview environment not found");
    if (environment.status === "torn_down") {
        throw new ConflictError("Environment has been torn down and cannot be redeployed");
    }
    const { githubRepositoryId } = environment;
    if (githubRepositoryId == null) {
        throw new ConflictError("Environment predates redeploy support and cannot be redeployed");
    }
    return { environment, githubRepositoryId };
}

interface RedeployableEnvironment {
    status: PreviewkitStatus;
    githubRepositoryId: number | null;
}

/** Instance rows are authoritative; the stored config is the fallback for environments predating them. */
function environmentHasApp(
    appInstances: Array<{ appName: string }>,
    resolvedConfig: unknown,
    appName: string,
): boolean {
    if (appInstances.some((instance) => instance.appName === appName)) return true;
    const parsed = resolvedConfigAppsSchema.safeParse(resolvedConfig);
    return parsed.success && parsed.data.apps.some((app) => app.name === appName);
}
