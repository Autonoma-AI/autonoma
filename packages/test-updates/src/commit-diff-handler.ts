import { type PrismaClient, TriggerSource } from "@autonoma/db";
import type { GitHubApp } from "@autonoma/github";
import { type Logger, logger } from "@autonoma/logger";
import { BranchAlreadyHasPendingSnapshotError, SnapshotDraft } from "./snapshot-draft";

export class MissingLastHandledShaError extends Error {
    constructor(branchId: string) {
        super(`Branch ${branchId} has no lastHandledSha set - cannot check for new commits`);
        this.name = "MissingLastHandledShaError";
    }
}

export class MissingGithubRefError extends Error {
    constructor(branchId: string) {
        super(`Branch ${branchId} has no githubRef set - cannot check for new commits`);
        this.name = "MissingGithubRefError";
    }
}

export class MissingGithubRepositoryError extends Error {
    constructor(branchId: string) {
        super(`Branch ${branchId} has no GitHub repository linked to its application`);
        this.name = "MissingGithubRepositoryError";
    }
}

export class InvalidRepositoryFullNameError extends Error {
    constructor(fullName: string) {
        super(`Invalid GitHub repository fullName: ${fullName}`);
        this.name = "InvalidRepositoryFullNameError";
    }
}

export type TriggerDiffPlanner = ({ branchId }: { branchId: string }) => Promise<void>;

/**
 * Checks whether a branch has new commits and creates a pending snapshot if so.
 * After creating the snapshot, triggers the diff planner workflow.
 */
export class CommitDiffHandler {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly githubApp: GitHubApp,
        private readonly triggerDiffPlanner: TriggerDiffPlanner,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    /**
     * Checks if a branch has new commits and creates a pending snapshot if so.
     *
     * Returns undefined (without throwing) if:
     * - No new commits after lastHandledSha
     * - Branch already has a pending snapshot (another job is running)
     *
     * @throws {MissingGithubRefError} If the branch has no githubRef configured.
     * @throws {MissingLastHandledShaError} If the branch has no lastHandledSha set.
     * @throws {MissingGithubRepositoryError} If the application has no GitHub repository linked.
     * @throws {InvalidRepositoryFullNameError} If the repository fullName is malformed.
     * @returns The snapshot ID if one was created, undefined otherwise.
     */
    async checkForChanges(branchId: string): Promise<string | undefined> {
        this.logger.info("Checking for new commits", { branchId });

        const branch = await this.db.branch.findUniqueOrThrow({
            where: { id: branchId },
            select: {
                lastHandledSha: true,
                githubRef: true,
                application: {
                    select: {
                        githubRepositories: {
                            select: { fullName: true, installation: { select: { installationId: true } } },
                        },
                    },
                },
            },
        });

        if (branch.githubRef == null) throw new MissingGithubRefError(branchId);
        if (branch.lastHandledSha == null) throw new MissingLastHandledShaError(branchId);

        // TODO: Review this 1-n application-github_repository relation
        const repo = branch.application.githubRepositories[0];
        if (repo == null) throw new MissingGithubRepositoryError(branchId);

        const [owner, repoName] = repo.fullName.split("/");
        if (owner == null || repoName == null) throw new InvalidRepositoryFullNameError(repo.fullName);

        const client = await this.githubApp.getInstallationClient(repo.installation.installationId);
        const history = client.getHistory(owner, repoName, branch.githubRef);

        const headSha = await history.nextCommitOnBranch(branch.lastHandledSha);

        if (headSha == null) {
            this.logger.info("No new commits found", { branchId });
            return undefined;
        }

        this.logger.info("New commit found", { branchId, headSha, baseSha: branch.lastHandledSha });

        let snapshotDraft: SnapshotDraft;
        try {
            snapshotDraft = await SnapshotDraft.start({
                db: this.db,
                branchId,
                source: TriggerSource.GITHUB_PUSH,
                headSha,
                baseSha: branch.lastHandledSha,
            });
        } catch (error) {
            if (error instanceof BranchAlreadyHasPendingSnapshotError) {
                this.logger.warn("Branch already has a pending snapshot, skipping", { branchId });
                return undefined;
            }
            throw error;
        }

        const latestSha = await history.latestBetween(headSha, branch.lastHandledSha);
        await this.db.branch.update({
            where: { id: branchId },
            data: { lastHandledSha: latestSha },
        });

        this.logger.info("Snapshot created for new commit, triggering diff planner", {
            branchId,
            snapshotId: snapshotDraft.snapshotId,
            headSha,
        });

        await this.triggerDiffPlanner({ branchId });

        return snapshotDraft.snapshotId;
    }
}
