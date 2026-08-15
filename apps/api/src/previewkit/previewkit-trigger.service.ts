import type { BillingService } from "@autonoma/billing";
import type {
    OnboardingPreviewEnvironmentMode,
    OnboardingStep,
    Prisma,
    PreviewkitStatus,
    PrismaClient,
} from "@autonoma/db";
import { ConflictError, InsufficientPreviewCreditsError, NotFoundError } from "@autonoma/errors";
import { autonomaHostsPreviews } from "@autonoma/scenario";
import {
    hasGoneLive,
    type PreviewRedeployAppMode,
    type PreviewTeardownTarget,
    type TriggerPreviewRedeployAppParams,
} from "@autonoma/types";
import type { AnalysisRunWorkflowInput, PreviewBuildWorkflowInput } from "@autonoma/workflow";
import { z } from "zod";
import { env } from "../env";
import { applicationBranchRefs } from "../github/application-branch-refs";
import { isBaseTrunkGateEnforced } from "../github/base-trunk-gate";
import { githubErrorStatus, normalizeBranchName, sameGitRef } from "../github/git-ref";
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
    /**
     * The analysis workflow this deploy started, when it went through one. Absent for a
     * repo with no resolvable branch, which builds directly.
     *
     * Carried so the caller can say what it queued. Without it a deploy request is
     * unfalsifiable after the fact - the only way to check whether anything ran is
     * cluster access, and the agents that ask for deploys have none.
     */
    workflowId?: string;
}

/** What a run request queued, for a caller that has to prove it queued anything. */
export interface PreviewRunReceipt {
    workflowId?: string;
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
        private readonly startAnalysisRun: (input: AnalysisRunWorkflowInput) => Promise<string>,
        private readonly startPreviewBuild: (input: PreviewBuildWorkflowInput) => Promise<void>,
        private readonly triggerTeardown: (target: PreviewTeardownTarget) => Promise<void>,
        private readonly triggerRedeployApp: (params: TriggerPreviewRedeployAppParams) => Promise<void>,
    ) {
        super();
    }

    /** Credits are checked HERE so every caller surfaces the same refusal. */
    async startRun(request: PreviewkitRunRequest, action: PreviewDeployAction = "opened"): Promise<PreviewRunReceipt> {
        this.logger.info("Starting a preview run", {
            repo: request.repoFullName,
            pr: request.prNumber,
            action,
        });

        await this.assertDeployCreditsAvailable(request.organizationId, request.repoFullName, request.prNumber);

        if (request.branchId == null) {
            await this.startBuildWithoutRun(request);
            return {};
        }

        const workflowId = await this.startAnalysisRun({
            branchId: request.branchId,
            headSha: request.headSha,
            baseSha: request.baseSha,
        });
        return { workflowId };
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

        const application = await this.readApplicationForRepo(organizationId, repo.id);

        if (application != null && !autonomaHostsPreviews(application.previewEnvironmentMode)) {
            this.logger.info("Skipping the preview run: the customer deploys this app's previews", {
                action,
                organizationId,
                repo: repo.full_name,
                pr: pr.number,
            });
            return;
        }

        // Nothing is owed to a pull request on an application that has not gone live. Autonoma has
        // no verdict to reach on it (there is no test suite yet) and nothing to say on the thread,
        // which is what both onboarding playbooks already promise the agent. The preview the SETUP
        // needs is environment 0, and it is reached through `push` and explicit deploys rather than
        // here, so gating this leaves the iterate-and-redeploy loop untouched.
        if (application != null && !hasGoneLive(application.step)) {
            this.logger.info("Skipping the preview run: the application has not gone live yet", {
                action,
                organizationId,
                repo: repo.full_name,
                pr: pr.number,
                extra: { step: application.step },
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

        // Only a PR merging INTO the app's trunk is in scope for orgs that opt in. The trunk ref came from the
        // application read above, so the comparison is free; the org-flag lookup runs only when the base differs. An
        // app with no recorded trunk (or an unlinked repo) cannot be judged either way, so it is left to proceed.
        const trunkRef = application?.trunkRef;
        const baseIsOffTrunk = trunkRef != null && !sameGitRef(pr.base.ref, trunkRef);
        if (baseIsOffTrunk && (await isBaseTrunkGateEnforced(this.db, organizationId))) {
            this.logger.info("Skipping the preview run: the PR does not target the app's main branch", {
                action,
                organizationId,
                repo: repo.full_name,
                pr: pr.number,
                extra: { baseRef: pr.base.ref },
            });
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
     * The onboarding facts both webhook gates need, in one read.
     *
     * Undefined when no Application is linked to the repository. That is NOT the same as an
     * unfinished one: there is no onboarding choice to disagree with and no customer to hold back
     * from, so `startRun` falls back to an unlinked best-effort build via `startBuildWithoutRun`.
     * An Application that has made no preview choice yet counts as customer-deployed, matching the
     * run's own `resolvePreviewTarget` - a webhook cannot know a preview URL, so opening a run
     * there would test a preview nobody recorded.
     */
    private async readApplicationForRepo(
        organizationId: string,
        githubRepositoryId: number,
    ): Promise<
        | { step?: OnboardingStep; previewEnvironmentMode?: OnboardingPreviewEnvironmentMode; trunkRef?: string }
        | undefined
    > {
        const application = await this.db.application.findUnique({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId } },
            select: {
                onboardingState: { select: { step: true, previewEnvironmentMode: true } },
                mainBranchInfo: { select: { githubRef: true } },
            },
        });
        if (application == null) return undefined;
        return {
            step: application.onboardingState?.step,
            previewEnvironmentMode: application.onboardingState?.previewEnvironmentMode ?? undefined,
            trunkRef: application.mainBranchInfo?.githubRef ?? undefined,
        };
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

        const application = await this.readApplicationForRepo(organizationId, repo.id);
        if (application != null && !autonomaHostsPreviews(application.previewEnvironmentMode)) {
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

        if (!env.PREVIEWKIT_MAIN_BRANCH_BUILDS_ENABLED) {
            throw new ConflictError("Main-branch preview builds are temporarily disabled");
        }

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
                previewDeployRef: true,
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
        // The repo default applies only when the app has no refs at all, never as a silent fallback for a ref
        // that has gone missing - a chosen branch that no longer exists errors below.
        const branchName = normalizeBranchName(applicationBranchRefs(application).deploy ?? repo.defaultBranch);
        const headSha = await this.githubInstallationService
            .getBranchHead(application.organizationId, githubRepositoryId, branchName)
            .catch((err: unknown) => {
                if (githubErrorStatus(err) === 404) return undefined;
                throw err;
            });

        if (headSha == null) throw new NotFoundError(`Deploy branch '${branchName}' not found on GitHub`);

        const receipt = await this.startRun(
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
            workflowId: receipt.workflowId,
        };
    }

    /**
     * Environment 0 has no pull request, so `push` is the only signal that its branch moved - and it fires for
     * every branch of every connected repo, which is why most deliveries here resolve to nothing.
     */
    async startMainBranchRunFromPushWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        // Correcting the deploy ref is bookkeeping rather than a build, so it runs even
        // with main-branch builds switched off - otherwise the kill switch quietly
        // leaves apps pinned to branches that no longer exist.
        if (await this.releaseDeployRefForDeletedBranch(organizationId, payload)) return;

        if (!env.PREVIEWKIT_MAIN_BRANCH_BUILDS_ENABLED) {
            this.logger.info("Skipped main-branch push deploy: main-branch builds are disabled", { organizationId });
            return;
        }

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

    /**
     * Deleting the branch the base preview follows hands it back to the app's trunk.
     *
     * This is the end of an onboarding: the integration branch carrying the preview
     * config merges, GitHub deletes it, and the base preview should go back to
     * tracking the trunk rather than pointing at a ref that no longer exists - which
     * would fail every subsequent deploy with "Deploy branch not found on GitHub"
     * while the stale environment kept accruing preview usage.
     *
     * Returns true when it handled the delivery, so the caller stops: a deletion is
     * never also a deploy target.
     */
    private async releaseDeployRefForDeletedBranch(
        organizationId: string,
        payload: Record<string, unknown>,
    ): Promise<boolean> {
        const parsed = pushWebhookSchema.safeParse(payload);
        if (!parsed.success) return false;

        const { ref, after, deleted, repository } = parsed.data;
        if (!ref.startsWith("refs/heads/")) return false;
        const isDeletion = deleted === true || ZERO_SHA.test(after);
        if (!isDeletion) return false;

        const branch = normalizeBranchName(ref);
        const application = await this.db.application.findFirst({
            where: { organizationId, githubRepositoryId: repository.id, previewDeployRef: branch },
            select: { id: true },
        });
        if (application == null) return true;

        this.logger.info("Deploy branch was deleted; returning the base preview to the app's trunk", {
            applicationId: application.id,
            repo: repository.full_name,
            extra: { deletedBranch: branch },
        });
        await this.db.application.update({ where: { id: application.id }, data: { previewDeployRef: null } });

        // Best-effort, and the ref is corrected FIRST so it survives whatever happens
        // here. The trunk is not guaranteed to resolve - an app whose trunk was itself
        // overwritten by an old deploy-branch choice can be pointed at a branch that is
        // also gone - and the deploy can decline for reasons that have nothing to do
        // with this webhook (main-branch builds switched off, no credits, the
        // installation losing access). Letting any of those escape would turn a
        // successful correction into a 500 that GitHub retries, and the retry finds the
        // ref already cleared and does nothing - so the preview would never redeploy at
        // all. Logged instead; the next push to the trunk picks it up.
        try {
            await this.startMainBranchRun(application.id, organizationId);
        } catch (err) {
            this.logger.warn("Could not redeploy the base preview on the trunk after its deploy branch was deleted", {
                applicationId: application.id,
                err,
            });
        }
        return true;
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
