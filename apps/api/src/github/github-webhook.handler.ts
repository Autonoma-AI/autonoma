import type { PrismaClient } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import type { CommitDiffHandler } from "@autonoma/test-updates";
import type { GitHubInstallationService } from "./github-installation.service";

export class GitHubWebhookHandler {
    constructor(
        private readonly service: GitHubInstallationService,
        private readonly db: PrismaClient,
        private readonly commitDiffHandler: CommitDiffHandler,
    ) {}

    async handleInstallationCreated(
        installationId: number,
        orgId: string,
        accountLogin: string,
        accountId: number,
        accountType: string,
    ): Promise<void> {
        logger.info("GitHub webhook: installation.created", { installationId, orgId });

        await this.service.handleInstallation(installationId, orgId, accountLogin, accountId, accountType);
    }

    async handleInstallationDeleted(installationId: number): Promise<void> {
        logger.info("GitHub webhook: installation.deleted", { installationId });

        await this.service.handleUninstall(installationId);
    }

    async handleInstallationSuspended(installationId: number): Promise<void> {
        logger.info("GitHub webhook: installation.suspend", { installationId });

        await this.service.handleSuspend(installationId);
    }

    async handlePullRequest(action: string, prNumber: number, repoFullName: string, headRef: string): Promise<void> {
        logger.info("GitHub webhook: pull_request event", { action, prNumber, repo: repoFullName, headRef });

        const isRelevantAction = action === "opened" || action === "synchronize";
        if (!isRelevantAction) {
            logger.info("GitHub webhook: pull_request action ignored", { action, prNumber });
            return;
        }

        const branchName = headRef.replace("refs/heads/", "");

        const repo = await this.db.gitHubRepository.findFirst({
            where: {
                fullName: repoFullName,
                applicationId: { not: null },
            },
            select: { applicationId: true },
        });

        if (repo?.applicationId == null) {
            logger.info("GitHub webhook: pull_request ignored - no matching repo with app", {
                repo: repoFullName,
                prNumber,
            });
            return;
        }

        let branch = await this.db.branch.findFirst({
            where: {
                applicationId: repo.applicationId,
                githubRef: branchName,
            },
            select: { id: true },
        });

        if (branch == null) {
            logger.info("GitHub webhook: auto-creating branch for pull request", {
                applicationId: repo.applicationId,
                branchName,
                prNumber,
            });

            const organization = await this.db.application.findFirst({
                where: { id: repo.applicationId },
                select: { organizationId: true },
            });

            if (organization == null) return;

            branch = await this.db.branch.create({
                data: {
                    name: branchName,
                    githubRef: branchName,
                    prNumber,
                    applicationId: repo.applicationId,
                    organizationId: organization.organizationId,
                },
                select: { id: true },
            });
        } else {
            const existing = await this.db.branch.findFirst({
                where: { id: branch.id },
                select: { prNumber: true },
            });

            if (existing?.prNumber == null) {
                await this.db.branch.update({
                    where: { id: branch.id },
                    data: { prNumber },
                });
            }
        }

        const snapshotId = await this.commitDiffHandler.checkForChanges(branch.id);

        if (snapshotId != null) {
            logger.info("GitHub webhook: snapshot created for pull_request", {
                repo: repoFullName,
                prNumber,
                branchName,
                branchId: branch.id,
                snapshotId,
            });
        } else {
            logger.info("GitHub webhook: pull_request handled, no snapshot created", {
                repo: repoFullName,
                prNumber,
                branchName,
                branchId: branch.id,
            });
        }
    }

    async handlePush(repoFullName: string, ref: string, installationId: number): Promise<void> {
        logger.info("GitHub webhook: push event", { repo: repoFullName, ref, installationId });

        const branchName = ref.replace("refs/heads/", "");

        const repo = await this.db.gitHubRepository.findFirst({
            where: {
                fullName: repoFullName,
                applicationId: { not: null },
                watchBranch: branchName,
                application: { disabled: false },
            },
            select: { applicationId: true },
        });

        if (repo?.applicationId == null) {
            logger.info("GitHub webhook: push ignored - no matching watched repo", {
                repo: repoFullName,
                ref,
                branchName,
            });
            return;
        }

        const branch = await this.db.branch.findFirst({
            where: {
                applicationId: repo.applicationId,
                githubRef: branchName,
            },
            select: { id: true },
        });

        if (branch == null) {
            logger.info("GitHub webhook: push ignored - no matching branch with githubRef", {
                repo: repoFullName,
                branchName,
                applicationId: repo.applicationId,
            });
            return;
        }

        const snapshotId = await this.commitDiffHandler.checkForChanges(branch.id);

        if (snapshotId != null) {
            logger.info("GitHub webhook: snapshot created for push", {
                repo: repoFullName,
                branchName,
                branchId: branch.id,
                snapshotId,
            });
        } else {
            logger.info("GitHub webhook: push handled, no snapshot created", {
                repo: repoFullName,
                branchName,
                branchId: branch.id,
            });
        }
    }
}
