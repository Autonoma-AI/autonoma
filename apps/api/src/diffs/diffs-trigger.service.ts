import type { PrismaClient } from "@autonoma/db";
import { TriggerSource } from "@autonoma/db";
import { BadRequestError, InternalError, NotFoundError } from "@autonoma/errors";
import { BranchAlreadyHasPendingSnapshotError, createDetachedSnapshot, TestSuiteUpdater } from "@autonoma/test-updates";
import type { TriggerDiffsJobParams, TriggerInvestigationJobParams } from "@autonoma/workflow";
import { env } from "../env";
import type { GitHubInstallationService } from "../github/github-installation.service";
import { upsertPrBranch } from "../routes/branches/upsert-pr-branch";
import { Service } from "../routes/service";

interface BaseTriggerDiffsParams {
    organizationId: string;
    repoId: number;
    url: string;
    webhookUrl?: string;
    webhookHeaders?: Record<string, string>;
    environment?: string;
}

interface TriggerPrDiffsParams extends BaseTriggerDiffsParams {
    prNumber: number;
}

type TriggerMainDiffsParams = BaseTriggerDiffsParams;

interface TriggerDiffsParams extends BaseTriggerDiffsParams {
    prNumber?: number;
    githubRef: string;
}

export interface TriggerDiffsResult {
    branchId: string;
    snapshotId?: string;
    deploymentId?: string;
    /** True when the request was a no-op: the head sha was already analyzed, so no snapshot/diffs job was created. */
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
        private readonly triggerDiffsJob: (params: TriggerDiffsJobParams) => Promise<void>,
        private readonly cancelDiffsJob: (snapshotId: string) => Promise<void>,
        private readonly triggerInvestigationJob: (params: TriggerInvestigationJobParams) => Promise<void>,
        private readonly cancelInvestigationJob: (snapshotId: string) => Promise<void>,
    ) {
        super();
    }

    /**
     * Fire the shadow investigation workflow in PARALLEL with the diffs job, behind a feature flag. It must
     * never block or fail the diffs trigger, so errors are swallowed (logged) and it is best-effort.
     *
     * The investigation agent runs on its OWN detached snapshot (a baseline clone that is never wired to a
     * branch pointer), so its shadow generations never pollute the diffs snapshot's pending-generation set.
     * The diffs snapshot is paired to that twin via `investigationSnapshotId` so the PR view can resolve the
     * report in one hop. When the branch has no baseline suite to fork from, there is nothing to investigate.
     */
    private async maybeTriggerInvestigation(params: {
        diffsSnapshotId: string;
        branchId: string;
        organizationId: string;
        headSha: string;
        baseSha: string;
    }): Promise<void> {
        if (!env.INVESTIGATION_SHADOW_ENABLED) return;
        const { diffsSnapshotId, branchId, organizationId, headSha, baseSha } = params;
        try {
            const created = await createDetachedSnapshot({
                db: this.db,
                branchId,
                organizationId,
                source: TriggerSource.WEBHOOK,
                headSha,
                baseSha,
            });
            if (created == null) {
                this.logger.info("No baseline suite; skipping shadow investigation", {
                    snapshot: { snapshotId: diffsSnapshotId },
                });
                return;
            }

            await this.db.branchSnapshot.update({
                where: { id: diffsSnapshotId },
                data: { investigationSnapshotId: created.snapshotId },
            });

            await this.triggerInvestigationJob({ snapshotId: created.snapshotId });
            this.logger.info("Shadow investigation triggered on detached snapshot", {
                snapshot: { snapshotId: created.snapshotId },
                extra: { diffsSnapshotId },
            });
        } catch (error) {
            this.logger.warn("Failed to trigger shadow investigation", {
                snapshot: { snapshotId: diffsSnapshotId },
                extra: { error: String(error) },
            });
        }
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
    }: TriggerPrDiffsParams): Promise<TriggerDiffsResult> {
        this.logger.info("Triggering PR diffs analysis", { organizationId, repoId, prNumber });

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
        const baseSha = branch.activeSnapshotHeadSha ?? pullRequest.baseSha;

        this.logger.info("Resolved branch and shas", { branchId: branch.id, headSha, baseSha });

        // Idempotency: a re-delivered webhook (GitHub retry, client repost) for an
        // already-analyzed head has nothing new to diff. Drop it instead of
        // re-running the full pipeline. `createSnapshot` still supersedes a pending
        // snapshot if the head genuinely moved while one was in flight.
        if (headSha === baseSha) {
            this.logger.info("Skipping PR diffs: head already analyzed, no new commits", {
                branchId: branch.id,
                prNumber,
                headSha,
            });
            return { branchId: branch.id, skipped: true };
        }

        const deploymentId = await this.createDeployment({
            branchId: branch.id,
            organizationId,
            url,
            webhookUrl,
            webhookHeaders,
        });

        const snapshotId = await this.createSnapshot(branch.id, organizationId, headSha, baseSha);

        await this.triggerDiffsJob({ branchId: branch.id, snapshotId });
        await this.maybeTriggerInvestigation({
            diffsSnapshotId: snapshotId,
            branchId: branch.id,
            organizationId,
            headSha,
            baseSha,
        });

        this.logger.info("PR diffs analysis triggered successfully", {
            branchId: branch.id,
            snapshotId,
            deploymentId,
            headSha,
            baseSha,
        });

        return { branchId: branch.id, snapshotId, deploymentId };
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
                mainBranch: {
                    select: {
                        id: true,
                        activeSnapshot: { select: { headSha: true } },
                    },
                },
                mainBranchInfo: { select: { githubRef: true } },
            },
        });

        if (app == null) throw new NoApplicationLinkedError(repoId);

        if (app.mainBranch == null || app.mainBranchInfo == null) throw new NoMainBranchError(app.id);

        const activeSnapshotHeadSha = app.mainBranch.activeSnapshot?.headSha;
        if (activeSnapshotHeadSha == null) throw new NoActiveSnapshotHeadShaError(app.mainBranch.id);

        const branchId = app.mainBranch.id;
        const baseSha = activeSnapshotHeadSha;
        const headSha = await this.githubInstallationService.getBranchHead(
            organizationId,
            repoId,
            app.mainBranchInfo.githubRef,
        );

        this.logger.info("Resolved main branch and shas", { branchId, headSha, baseSha });

        // Idempotency: re-delivered webhooks (GitHub retry, client repost) for an
        // unchanged main carry the same head as the active snapshot. Drop them
        // rather than re-running diffs. A real new commit moves headSha, so this
        // only collapses true duplicates.
        if (headSha === baseSha) {
            this.logger.info("Skipping main diffs: head matches active snapshot, no new commits", {
                branchId,
                headSha,
            });
            return { branchId, skipped: true };
        }

        const deploymentId = await this.createDeployment({
            branchId,
            organizationId,
            url,
            webhookUrl,
            webhookHeaders,
        });

        const snapshotId = await this.createSnapshot(branchId, organizationId, headSha, baseSha);

        await this.triggerDiffsJob({ branchId, snapshotId });
        await this.maybeTriggerInvestigation({
            diffsSnapshotId: snapshotId,
            branchId,
            organizationId,
            headSha,
            baseSha,
        });

        this.logger.info("Main branch diffs analysis triggered successfully", {
            branchId,
            snapshotId,
            deploymentId,
            headSha,
            baseSha,
        });

        return { branchId, snapshotId, deploymentId };
    }

    private async createDeployment({
        branchId,
        organizationId,
        url,
        webhookUrl,
        webhookHeaders,
    }: {
        branchId: string;
        organizationId: string;
        url: string;
        webhookUrl?: string;
        webhookHeaders?: Record<string, string>;
    }): Promise<string> {
        this.logger.info("Creating branch deployment", { branchId, url });

        const mergedWebhookHeaders = await this.injectPreviewkitBypassHeader(url, webhookHeaders);

        return this.db.$transaction(async (tx) => {
            const deployment = await tx.branchDeployment.create({
                data: {
                    branchId,
                    organizationId,
                    webhookUrl,
                    webhookHeaders: mergedWebhookHeaders,
                    webDeployment: {
                        create: {
                            url,
                            file: "",
                            organizationId,
                        },
                    },
                },
            });

            await tx.branch.update({
                where: { id: branchId },
                data: { deploymentId: deployment.id },
            });

            this.logger.info("Branch deployment created", { branchId, deploymentId: deployment.id, url });

            return deployment.id;
        });
    }

    private async injectPreviewkitBypassHeader(
        url: string,
        webhookHeaders: Record<string, string> | undefined,
    ): Promise<Record<string, string> | undefined> {
        const instance = await this.db.previewkitAppInstance.findFirst({
            where: { url },
            select: { environment: { select: { bypassToken: true } } },
        });

        const bypassToken = instance?.environment.bypassToken;
        if (bypassToken == null) {
            this.logger.info("No previewkit bypass token for deployment URL; webhook headers unchanged", { url });
            return webhookHeaders;
        }

        this.logger.info("Injecting previewkit bypass header into webhook headers", { url });
        return { ...(webhookHeaders ?? {}), "x-previewkit-bypass": bypassToken };
    }

    private async createSnapshot(
        branchId: string,
        organizationId: string,
        headSha: string,
        baseSha: string,
    ): Promise<string> {
        try {
            const updater = await TestSuiteUpdater.startUpdate({
                db: this.db,
                branchId,
                organizationId,
                source: TriggerSource.WEBHOOK,
                headSha,
                baseSha,
            });
            await this.createDiffsJob(updater.snapshotId, organizationId);
            return updater.snapshotId;
        } catch (error) {
            if (!(error instanceof BranchAlreadyHasPendingSnapshotError)) throw error;

            this.logger.info("Cancelling existing diffs job and superseding pending snapshot", { branchId });

            const staleUpdater = await TestSuiteUpdater.continueUpdate({ db: this.db, branchId });
            await this.cancelDiffsJob(staleUpdater.snapshotId);
            await this.supersedeInvestigation(staleUpdater.snapshotId);
            await staleUpdater.cancel();
            await this.markDiffsJobSuperseded(staleUpdater.snapshotId);

            this.logger.info("Stale snapshot cancelled, starting fresh update", {
                branchId,
                staleSnapshotId: staleUpdater.snapshotId,
            });

            const updater = await TestSuiteUpdater.startUpdate({
                db: this.db,
                branchId,
                organizationId,
                source: TriggerSource.WEBHOOK,
                headSha,
                baseSha,
            });
            await this.createDiffsJob(updater.snapshotId, organizationId);
            return updater.snapshotId;
        }
    }

    private async createDiffsJob(snapshotId: string, organizationId: string): Promise<void> {
        await this.db.diffsJob.create({
            data: { snapshotId, organizationId, status: "pending" },
        });
        this.logger.info("DiffsJob created", { snapshotId });
    }

    /**
     * Cancel the investigation twin (if any) of a diffs snapshot being superseded: stop its in-flight workflow
     * so it does not keep running shadow tests against a soon-to-be-replaced preview, and mark its detached
     * snapshot `cancelled` so its state is terminal. Best-effort - never blocks the fresh diffs trigger.
     */
    private async supersedeInvestigation(staleDiffsSnapshotId: string): Promise<void> {
        try {
            const stale = await this.db.branchSnapshot.findUnique({
                where: { id: staleDiffsSnapshotId },
                select: { investigationSnapshotId: true },
            });
            const investigationSnapshotId = stale?.investigationSnapshotId;
            if (investigationSnapshotId == null) return;

            await this.cancelInvestigationJob(investigationSnapshotId);
            await this.db.branchSnapshot.update({
                where: { id: investigationSnapshotId },
                data: { status: "cancelled" },
            });
            this.logger.info("Superseded investigation snapshot cancelled", {
                snapshot: { snapshotId: investigationSnapshotId },
                extra: { staleDiffsSnapshotId },
            });
        } catch (error) {
            this.logger.warn("Failed to supersede investigation snapshot", {
                snapshot: { snapshotId: staleDiffsSnapshotId },
                extra: { error: String(error) },
            });
        }
    }

    private async markDiffsJobSuperseded(snapshotId: string): Promise<void> {
        try {
            await this.db.diffsJob.update({
                where: { snapshotId },
                data: {
                    status: "failed",
                    failureReason: "Superseded by a newer diffs request",
                    completedAt: new Date(),
                },
            });
            this.logger.info("Stale DiffsJob marked as superseded", { snapshotId });
        } catch (error) {
            this.logger.warn("Failed to mark stale DiffsJob as superseded", { snapshotId, extra: { error } });
        }
    }
}
