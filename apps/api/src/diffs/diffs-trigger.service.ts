import type { PrismaClient } from "@autonoma/db";
import { TriggerSource } from "@autonoma/db";
import { BadRequestError, InternalError, NotFoundError } from "@autonoma/errors";
import type { DiffsRunPreparer } from "@autonoma/test-updates";
import { createDetachedSnapshot } from "@autonoma/test-updates";
import type { PipelineWorkflows } from "@autonoma/workflow";
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
        // Owns the whole run start (deployment + snapshot, per-org analysis-vs-diffs, supersede, investigation
        // shadow), shared with the PreviewKit diffs-worker path. Injected ready-built; this service only resolves
        // the branch/shas around it.
        private readonly preparer: DiffsRunPreparer,
        // Used only by the onboarding-recovery path (`reinvestigateOpenPrs`) to fire the investigation shadow
        // directly; the main trigger paths go through `preparer`.
        private readonly workflows: PipelineWorkflows,
    ) {
        super();
    }

    /**
     * Create a detached investigation snapshot for a branch head, pair it onto the given parent snapshot via
     * `investigationSnapshotId`, and fire the investigation workflow. Used by the onboarding-completion recovery
     * path (`reinvestigateOpenPrs`). Returns `undefined` when there is no baseline suite to fork from (nothing to
     * investigate). Callers own the containment (try/catch) so a failure never blocks them.
     */
    private async startInvestigationForHead(params: {
        branchId: string;
        organizationId: string;
        headSha: string;
        baseSha: string;
        parentSnapshotId: string;
    }): Promise<{ snapshotId: string } | undefined> {
        const { branchId, organizationId, headSha, baseSha, parentSnapshotId } = params;

        const created = await createDetachedSnapshot({
            db: this.db,
            branchId,
            organizationId,
            source: TriggerSource.WEBHOOK,
            headSha,
            baseSha,
        });
        if (created == null) {
            this.logger.info("No baseline suite; skipping investigation", {
                snapshot: { snapshotId: parentSnapshotId },
            });
            return undefined;
        }

        await this.db.branchSnapshot.update({
            where: { id: parentSnapshotId },
            data: { investigationSnapshotId: created.snapshotId },
        });

        await this.workflows.triggerInvestigation({ snapshotId: created.snapshotId });
        this.logger.info("Investigation triggered on detached snapshot", {
            snapshot: { snapshotId: created.snapshotId },
            extra: { parentSnapshotId },
        });
        return created;
    }

    /**
     * Recovery for the onboarding race: a PR investigation that finished while the app was still onboarding had
     * its comment suppressed by the onboarding gate (`isOnboardingComplete`) and nothing re-posts it. When the
     * app goes live we re-run a fresh investigation for every open PR that never got an investigation comment,
     * so the comment posts normally now that the gate passes. Only comment-less open PRs are targeted, bounding
     * this to a one-time compute per app. Best-effort per PR: one failure does not sink the rest.
     */
    async reinvestigateOpenPrs(applicationId: string, organizationId: string): Promise<void> {
        if (!env.INVESTIGATION_SHADOW_ENABLED) {
            this.logger.info("Investigation shadow disabled; skipping open-PR reinvestigation", { applicationId });
            return;
        }
        this.logger.info("Reinvestigating open PRs after go-live", { applicationId, organizationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });
        const repoId = application?.githubRepositoryId;
        if (repoId == null) {
            this.logger.info("Application has no linked repository; nothing to reinvestigate", { applicationId });
            return;
        }

        const openBranches = await this.db.branch.findMany({
            where: { applicationId, application: { organizationId }, prInfo: { prState: "open" } },
            select: {
                id: true,
                activeSnapshotId: true,
                prInfo: { select: { prNumber: true } },
            },
        });
        if (openBranches.length === 0) {
            this.logger.info("No open PRs to reinvestigate", { applicationId });
            return;
        }

        const repository = await this.githubInstallationService.getRepository(organizationId, repoId);
        const repoFullName = repository.fullName;

        const openPrNumbers = openBranches
            .map((branch) => branch.prInfo?.prNumber)
            .filter((prNumber): prNumber is number => prNumber != null);
        const existingComments = await this.db.gitHubPrComment.findMany({
            where: { repoFullName, kind: "investigation", prNumber: { in: openPrNumbers } },
            select: { prNumber: true },
        });
        const commentedPrNumbers = new Set(existingComments.map((comment) => comment.prNumber));

        let retriggered = 0;
        let skipped = 0;
        for (const branch of openBranches) {
            const prNumber = branch.prInfo?.prNumber;
            const alreadyCommented = prNumber != null && commentedPrNumbers.has(prNumber);
            if (prNumber == null || alreadyCommented || branch.activeSnapshotId == null) {
                skipped++;
                continue;
            }
            try {
                const pullRequest = await this.githubInstallationService.getPullRequest(
                    organizationId,
                    repoId,
                    prNumber,
                );
                await this.startInvestigationForHead({
                    branchId: branch.id,
                    organizationId,
                    headSha: pullRequest.headSha,
                    baseSha: pullRequest.baseSha,
                    parentSnapshotId: branch.activeSnapshotId,
                });
                retriggered++;
            } catch (error) {
                this.logger.warn("Failed to reinvestigate open PR", {
                    organizationId,
                    extra: { applicationId, prNumber, branchId: branch.id, error: String(error) },
                });
            }
        }

        this.logger.info("Open-PR reinvestigation complete", {
            applicationId,
            extra: { retriggered, skipped, totalOpen: openBranches.length },
        });
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

        const prepared = await this.preparer.prepare({
            branchId: branch.id,
            organizationId,
            headSha,
            baseSha,
            url,
            webhookUrl,
            webhookHeaders,
        });
        if (prepared.skipped) return { branchId: branch.id, skipped: true };

        this.logger.info("PR diffs analysis triggered successfully", {
            branchId: branch.id,
            snapshotId: prepared.snapshotId,
            deploymentId: prepared.deploymentId,
            headSha,
            baseSha,
        });

        return { branchId: branch.id, snapshotId: prepared.snapshotId, deploymentId: prepared.deploymentId };
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

        const prepared = await this.preparer.prepare({
            branchId,
            organizationId,
            headSha,
            baseSha,
            url,
            webhookUrl,
            webhookHeaders,
        });
        if (prepared.skipped) return { branchId, skipped: true };

        this.logger.info("Main branch diffs analysis triggered successfully", {
            branchId,
            snapshotId: prepared.snapshotId,
            deploymentId: prepared.deploymentId,
            headSha,
            baseSha,
        });

        return { branchId, snapshotId: prepared.snapshotId, deploymentId: prepared.deploymentId };
    }
}
