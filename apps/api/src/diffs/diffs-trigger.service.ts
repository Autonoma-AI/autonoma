import type { PrismaClient } from "@autonoma/db";
import { TriggerSource } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { BranchAlreadyHasPendingSnapshotError, SnapshotDraft, TestSuiteUpdater } from "@autonoma/test-updates";
import type { TriggerDiffsJobParams } from "@autonoma/workflow";
import type { GitHubInstallationService } from "../github/github-installation.service";
import { Service } from "../routes/service";

export interface TriggerDiffsParams {
    organizationId: string;
    repoId: number;
    prNumber: number;
    url: string;
    webhookUrl: string;
    webhookHeaders?: Record<string, string>;
    environment?: string;
}

export interface TriggerDiffsResult {
    branchId: string;
    snapshotId: string;
    deploymentId: string;
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

    async triggerDiffs({
        organizationId,
        repoId,
        prNumber,
        url,
        webhookUrl,
        webhookHeaders,
    }: TriggerDiffsParams): Promise<TriggerDiffsResult> {
        this.logger.info("Triggering diffs analysis", { organizationId, repoId, prNumber });

        const app = await this.db.application.findFirst({
            where: {
                organizationId,
                githubRepositoryId: repoId,
            },
            select: { id: true },
        });

        if (app == null) {
            throw new NotFoundError(`No application linked to repository ${repoId}`);
        }

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

        this.logger.info("Diffs analysis triggered successfully", {
            branchId: branch.id,
            snapshotId,
            deploymentId,
            headSha,
            baseSha,
        });

        return { branchId: branch.id, snapshotId, deploymentId };
    }

    private async upsertBranch(
        applicationId: string,
        organizationId: string,
        normalizedBranch: string,
        prNumber: number,
    ) {
        this.logger.info("Upserting branch", { applicationId, branch: normalizedBranch, prNumber });
        return this.db.branch.upsert({
            where: {
                applicationId_prNumber: { applicationId, prNumber },
            },
            create: {
                name: normalizedBranch,
                githubRef: normalizedBranch,
                prNumber,
                applicationId,
                organizationId,
            },
            update: {
                name: normalizedBranch,
                githubRef: normalizedBranch,
            },
            select: { id: true, lastHandledSha: true, prNumber: true },
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
