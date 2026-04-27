import type { PrismaClient } from "@autonoma/db";
import { TriggerSource } from "@autonoma/db";
import { BadRequestError, InternalError, NotFoundError } from "@autonoma/errors";
import { BranchAlreadyHasPendingSnapshotError, SnapshotDraft, TestSuiteUpdater } from "@autonoma/test-updates";
import type { TriggerDiffsJobParams } from "@autonoma/workflow";
import type { GitHubInstallationService } from "../github/github-installation.service";
import { Service } from "../routes/service";

interface BaseTriggerDiffsParams {
    organizationId: string;
    repoId: number;
    url: string;
    webhookUrl: string;
    webhookHeaders?: Record<string, string>;
    environment?: string;
}

interface TriggerPrDiffsParams extends BaseTriggerDiffsParams {
    prNumber: number;
}

interface TriggerMainDiffsParams extends BaseTriggerDiffsParams {
    expectedGithubRef?: string;
}

interface TriggerDiffsParams extends BaseTriggerDiffsParams {
    prNumber?: number;
    githubRef: string;
}

export interface TriggerDiffsResult {
    branchId: string;
    snapshotId: string;
    deploymentId: string;
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

export class NoLastHandledShaError extends InternalError {
    constructor(public readonly branchId: string) {
        super(`Branch ${branchId} has no lastHandledSha`);
    }
}

export class DiffsTriggerService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly githubInstallationService: GitHubInstallationService,
        private readonly triggerDiffsJob: (params: TriggerDiffsJobParams) => Promise<void>,
        private readonly cancelDiffsJob: (snapshotId: string) => Promise<void>,
    ) {
        super();
    }

    async triggerDiffs(params: TriggerDiffsParams): Promise<TriggerDiffsResult> {
        if (params.prNumber != null) {
            return this.triggerPrDiffs({ ...params, prNumber: params.prNumber });
        } else {
            return this.triggerMainDiffs({ ...params, expectedGithubRef: params.githubRef });
        }
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

        const branch = await this.upsertBranch(app.id, organizationId, normalizedBranch, prNumber);
        const baseSha = branch.lastHandledSha ?? pullRequest.baseSha;

        this.logger.info("Resolved branch and shas", { branchId: branch.id, headSha, baseSha });

        const deploymentId = await this.createDeployment({
            branchId: branch.id,
            organizationId,
            url,
            webhookUrl,
            webhookHeaders,
        });

        const snapshotId = await this.createSnapshot(branch.id, organizationId, headSha, baseSha);

        await this.triggerDiffsJob({ branchId: branch.id, snapshotId });

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
        expectedGithubRef,
    }: TriggerMainDiffsParams): Promise<TriggerDiffsResult> {
        this.logger.info("Triggering main branch diffs analysis", { organizationId, repoId });

        const app = await this.db.application.findUnique({
            where: {
                organizationId_githubRepositoryId: { organizationId, githubRepositoryId: repoId },
            },
            select: {
                id: true,
                mainBranch: { select: { id: true, lastHandledSha: true } },
                mainBranchInfo: { select: { githubRef: true } },
            },
        });

        if (app == null) throw new NoApplicationLinkedError(repoId);

        if (app.mainBranch == null || app.mainBranchInfo == null) throw new NoMainBranchError(app.id);

        if (expectedGithubRef != null && app.mainBranchInfo.githubRef !== expectedGithubRef)
            throw new UnsupportedGitHubRefError(expectedGithubRef);

        if (app.mainBranch.lastHandledSha == null) throw new NoLastHandledShaError(app.mainBranch.id);

        const branchId = app.mainBranch.id;
        const baseSha = app.mainBranch.lastHandledSha;
        const headSha = await this.githubInstallationService.getBranchHead(
            organizationId,
            repoId,
            app.mainBranchInfo.githubRef,
        );

        this.logger.info("Resolved main branch and shas", { branchId, headSha, baseSha });

        const deploymentId = await this.createDeployment({
            branchId,
            organizationId,
            url,
            webhookUrl,
            webhookHeaders,
        });

        const snapshotId = await this.createSnapshot(branchId, organizationId, headSha, baseSha);

        await this.triggerDiffsJob({ branchId, snapshotId });

        this.logger.info("Main branch diffs analysis triggered successfully", {
            branchId,
            snapshotId,
            deploymentId,
            headSha,
            baseSha,
        });

        return { branchId, snapshotId, deploymentId };
    }

    private async upsertBranch(
        applicationId: string,
        organizationId: string,
        normalizedBranch: string,
        prNumber: number,
    ) {
        this.logger.info("Upserting branch", { applicationId, branch: normalizedBranch, prNumber });

        return this.db.$transaction(async (tx) => {
            const application = await tx.application.findUnique({
                where: { id: applicationId },
                select: { mainBranch: { select: { activeSnapshotId: true } } },
            });
            const baseSnapshotId = application?.mainBranch?.activeSnapshotId ?? undefined;

            const existing = await tx.featureBranchInfo.findUnique({
                where: { applicationId_prNumber: { applicationId, prNumber } },
                select: { branch: { select: { id: true, lastHandledSha: true } } },
            });

            if (existing != null) {
                await tx.branch.update({
                    where: { id: existing.branch.id },
                    data: { name: normalizedBranch },
                });
                return { id: existing.branch.id, lastHandledSha: existing.branch.lastHandledSha };
            }

            return tx.branch.create({
                data: {
                    name: normalizedBranch,
                    applicationId,
                    organizationId,
                    baseSnapshotId,
                    prInfo: { create: { applicationId, prNumber } },
                },
                select: { id: true, lastHandledSha: true },
            });
        });
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
        webhookUrl: string;
        webhookHeaders?: Record<string, string>;
    }): Promise<string> {
        this.logger.info("Creating branch deployment", { branchId, url });

        return this.db.$transaction(async (tx) => {
            const deployment = await tx.branchDeployment.create({
                data: {
                    branchId,
                    organizationId,
                    webhookUrl,
                    webhookHeaders,
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
            return updater.snapshotId;
        } catch (error) {
            if (!(error instanceof BranchAlreadyHasPendingSnapshotError)) throw error;

            this.logger.info("Cancelling existing diffs job and discarding pending snapshot", { branchId });

            const staleSnapshot = await SnapshotDraft.loadPending({ db: this.db, branchId });
            await this.cancelDiffsJob(staleSnapshot.snapshotId);
            await staleSnapshot.discard();

            this.logger.info("Stale snapshot discarded, starting fresh update", {
                branchId,
                staleSnapshotId: staleSnapshot.snapshotId,
            });

            const updater = await TestSuiteUpdater.startUpdate({
                db: this.db,
                branchId,
                organizationId,
                source: TriggerSource.WEBHOOK,
                headSha,
                baseSha,
            });
            return updater.snapshotId;
        }
    }
}
