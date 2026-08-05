import type { PrismaClient } from "@autonoma/db";
import { BadRequestError, InternalError, NotFoundError } from "@autonoma/errors";
import { recordBranchDeployment, resolveAnalysisBase } from "@autonoma/test-updates";
import type { AnalysisRunWorkflowInput } from "@autonoma/workflow";
import type { GitHubInstallationService } from "../github/github-installation.service";
import { upsertPrBranch } from "../routes/branches/upsert-pr-branch";
import { Service } from "../routes/service";

interface BaseTriggerDiffsParams {
    organizationId: string;
    repoId: number;
    /** Set when the CALLER knows the URL - a customer-deployed preview. One Autonoma hosts records its own. */
    url?: string;
    webhookUrl?: string;
    webhookHeaders?: Record<string, string>;
    environment?: string;
}

interface TriggerPrDiffsParams extends BaseTriggerDiffsParams {
    prNumber: number;
    /** True when a merge-gate trigger (e.g. `/start analysis`) explicitly requested this run, bypassing the org's activation gate. */
    requested?: boolean;
}

type TriggerMainDiffsParams = BaseTriggerDiffsParams;

interface TriggerDiffsParams extends BaseTriggerDiffsParams {
    prNumber?: number;
    githubRef: string;
}

export interface TriggerDiffsResult {
    branchId: string;
    /**
     * True when the request was a no-op: the head was already analyzed, or activation suppressed it. Absent means a
     * run is under way - either one this call started or one it attached to. No snapshot id: the run opens inside
     * its workflow, so the trigger never learns one.
     */
    skipped?: boolean;
}

export class NoApplicationLinkedError extends NotFoundError {
    constructor(public readonly repoId: number) {
        super(`No application linked to repository ${repoId}`);
    }
}

export class NoMainBranchError extends NotFoundError {
    constructor(public readonly appId: string) {
        super(`Application ${appId} has no main branch`);
    }
}

export class UnsupportedGitHubRefError extends BadRequestError {
    constructor(public readonly githubRef: string) {
        super(`Unsupported GitHub reference: ${githubRef}`);
    }
}

export class NoActiveSnapshotHeadShaError extends InternalError {
    constructor(public readonly branchId: string) {
        super(`Branch ${branchId} has no active snapshot with a headSha`);
    }
}

export class DiffsTriggerService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly githubInstallationService: GitHubInstallationService,
        /** Injected so a test can observe what a trigger asked for without standing up Temporal. */
        private readonly startAnalysisRun: (input: AnalysisRunWorkflowInput) => Promise<void>,
    ) {
        super();
    }

    async triggerDiffs(params: TriggerDiffsParams): Promise<TriggerDiffsResult> {
        const mainBranchInfo = await this.db.mainBranchInfo.findFirst({
            where: {
                application: {
                    organizationId: params.organizationId,
                    githubRepositoryId: params.repoId,
                },
            },
            select: { githubRef: true },
        });

        if (mainBranchInfo?.githubRef === params.githubRef) {
            return this.triggerMainDiffs(params);
        }
        if (params.prNumber != null) {
            return this.triggerPrDiffs({ ...params, prNumber: params.prNumber });
        }
        throw new UnsupportedGitHubRefError(params.githubRef);
    }

    async triggerPrDiffs({
        organizationId,
        repoId,
        prNumber,
        url,
        webhookUrl,
        webhookHeaders,
        requested,
    }: TriggerPrDiffsParams): Promise<TriggerDiffsResult> {
        this.logger.info("Triggering PR diffs analysis", { organizationId, repoId, prNumber, extra: { requested } });

        const app = await this.db.application.findFirst({
            where: {
                organizationId,
                githubRepositoryId: repoId,
            },
            select: { id: true },
        });

        if (app == null) throw new NoApplicationLinkedError(repoId);

        const pullRequest = await this.githubInstallationService.getPullRequest(organizationId, repoId, prNumber);
        const normalizedBranch = pullRequest.headRef;
        const headSha = pullRequest.headSha;

        const branch = await upsertPrBranch({
            db: this.db,
            applicationId: app.id,
            organizationId,
            prNumber,
            name: normalizedBranch,
        });
        const baseSha = pullRequest.baseSha;

        this.logger.info("Resolved branch and shas", { branchId: branch.id, headSha, baseSha });

        // A re-delivered webhook for an already-analyzed head has nothing new to diff. `createSnapshot` still
        // supersedes a pending snapshot if the head genuinely moved while one was in flight.
        const { alreadyAnalyzed } = await resolveAnalysisBase({
            db: this.db,
            branchId: branch.id,
            headSha,
            fallbackBaseSha: baseSha,
        });
        if (alreadyAnalyzed) {
            this.logger.info("Skipping PR diffs: head already analyzed, no new commits", {
                branchId: branch.id,
                prNumber,
                headSha,
            });
            return { branchId: branch.id, skipped: true };
        }

        // Ready-for-review fires here rather than from the `pull_request.ready_for_review` webhook: a
        // customer-deployed preview does not exist yet at webhook time, and this runs once it is live.
        let isAutoRunOnReady = false;
        if (!requested && (await this.isActivationGated(organizationId))) {
            isAutoRunOnReady = await this.autoRunsOnReady(branch.id);
            if (!isAutoRunOnReady) {
                this.logger.info("Activation: suppressing automatic run; a run starts only on an explicit request", {
                    branchId: branch.id,
                    extra: { organizationId, headSha },
                });
                return { branchId: branch.id, skipped: true };
            }
            this.logger.info("Activation: repo opted into auto-run-on-ready; proceeding with the automatic run", {
                branchId: branch.id,
                extra: { organizationId, headSha },
            });
        }

        // Dedupe of activation triggers racing on the same head: attach to the run an earlier trigger opened
        // instead of superseding it. This covers explicit-vs-explicit (a label added while a `/start analysis`
        // comment is mid-run) AND auto-vs-explicit (a preview-ready auto-run firing just after `/start analysis`
        // opened one).
        if (requested || isAutoRunOnReady) {
            const inFlight = await this.findInFlightRunForHead(branch.id, headSha);
            if (inFlight != null) {
                this.logger.info("Attaching to the in-flight run for this head; not starting a duplicate", {
                    branchId: branch.id,
                    snapshot: { snapshotId: inFlight.snapshotId },
                    extra: { headSha, requested: requested === true, isAutoRunOnReady },
                });
                return { branchId: branch.id };
            }
        }

        await this.startRun({
            branchId: branch.id,
            organizationId,
            headSha,
            baseSha,
            url,
            webhookUrl,
            webhookHeaders,
        });

        this.logger.info("PR diffs analysis triggered successfully", {
            branchId: branch.id,
            headSha,
            baseSha,
        });

        return { branchId: branch.id };
    }

    async triggerMainDiffs({
        organizationId,
        repoId,
        url,
        webhookUrl,
        webhookHeaders,
    }: TriggerMainDiffsParams): Promise<TriggerDiffsResult> {
        this.logger.info("Triggering main branch diffs analysis", { organizationId, repoId });

        const app = await this.db.application.findUnique({
            where: {
                organizationId_githubRepositoryId: { organizationId, githubRepositoryId: repoId },
            },
            select: {
                id: true,
                mainBranch: { select: { id: true } },
                mainBranchInfo: { select: { githubRef: true } },
            },
        });

        if (app == null) throw new NoApplicationLinkedError(repoId);

        if (app.mainBranch == null || app.mainBranchInfo == null) throw new NoMainBranchError(app.id);

        const branchId = app.mainBranch.id;
        const headSha = await this.githubInstallationService.getBranchHead(
            organizationId,
            repoId,
            app.mainBranchInfo.githubRef,
        );

        // Main has no pull request to fall back on, so its baseline snapshot is the only possible base.
        const { baseSha, alreadyAnalyzed } = await resolveAnalysisBase({ db: this.db, branchId, headSha });
        if (baseSha == null) throw new NoActiveSnapshotHeadShaError(branchId);

        this.logger.info("Resolved main branch and shas", { branchId, headSha, baseSha });

        // A re-delivered webhook for unchanged main carries the active snapshot's head. A real commit moves
        // headSha, so this only collapses true duplicates.
        if (alreadyAnalyzed) {
            this.logger.info("Skipping main diffs: head matches active snapshot, no new commits", {
                branchId,
                headSha,
            });
            return { branchId, skipped: true };
        }

        // Deliberately not activation-gated: activation only suppresses automatic PR analysis. A migrated org's
        // baseline snapshot must keep updating on main pushes, or every later PR diff computes against a stale base.
        await this.startRun({
            branchId,
            organizationId,
            headSha,
            url,
            webhookUrl,
            webhookHeaders,
        });

        this.logger.info("Main branch diffs analysis triggered successfully", { branchId, headSha, baseSha });

        return { branchId };
    }

    /**
     * A URL is recorded only for a preview that ALREADY exists: one Autonoma hosts would point the branch at the
     * previous deploy. Sequential on purpose - both mutate the branch row, so concurrency only contends on its lock.
     */
    private async startRun(params: {
        branchId: string;
        organizationId: string;
        headSha: string;
        /** The PR base, for a branch with no active snapshot yet. Main always has one, so it passes none. */
        baseSha?: string;
        url?: string;
        webhookUrl?: string;
        webhookHeaders?: Record<string, string>;
    }): Promise<void> {
        const { branchId, organizationId, headSha, baseSha, url, webhookUrl, webhookHeaders } = params;

        if (url != null) {
            await recordBranchDeployment({
                db: this.db,
                logger: this.logger,
                branchId,
                organizationId,
                url,
                webhookUrl,
                webhookHeaders,
            });
        }
        await this.startAnalysisRun({ branchId, headSha, baseSha });
    }

    /**
     * Undefined when there is no pending snapshot, when it is for a different head (a newer push must supersede
     * rather than attach), or when the branch has no deployment yet.
     */
    private async findInFlightRunForHead(
        branchId: string,
        headSha: string,
    ): Promise<{ snapshotId: string } | undefined> {
        const branch = await this.db.branch.findUnique({
            where: { id: branchId },
            select: {
                deploymentId: true,
                pendingSnapshot: { select: { id: true, status: true, headSha: true } },
            },
        });
        const pending = branch?.pendingSnapshot;
        if (pending == null || pending.status !== "processing") return undefined;
        if (pending.headSha !== headSha) return undefined;
        if (branch?.deploymentId == null) {
            this.logger.warn("In-flight snapshot for head has no branch deployment; cannot attach, will supersede", {
                branchId,
                snapshot: { snapshotId: pending.id },
                extra: { headSha },
            });
            return undefined;
        }
        return { snapshotId: pending.id };
    }

    /** Under activation, this is what lets an automatic preview-ready run through - fired once the preview is live. */
    private async autoRunsOnReady(branchId: string): Promise<boolean> {
        const branch = await this.db.branch.findUnique({
            where: { id: branchId },
            select: { application: { select: { triggerConfig: { select: { autoRunOnReadyForReview: true } } } } },
        });
        return branch?.application.triggerConfig?.autoRunOnReadyForReview === true;
    }

    /** Whether this org is migrated to activation, in which case an automatic run is suppressed. */
    private async isActivationGated(organizationId: string): Promise<boolean> {
        const settings = await this.db.organizationSettings.findUnique({
            where: { organizationId },
            select: { activationEnabled: true },
        });
        return settings?.activationEnabled === true;
    }
}
