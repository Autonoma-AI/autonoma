import type { PrismaClient } from "@autonoma/db";
import { TriggerSource } from "@autonoma/db";
import { BadRequestError, InternalError, NotFoundError } from "@autonoma/errors";
import { BranchAlreadyHasPendingSnapshotError, createDetachedSnapshot, TestSuiteUpdater } from "@autonoma/test-updates";
import type {
    TriggerAnalysisJobParams,
    TriggerDiffsJobParams,
    TriggerInvestigationJobParams,
} from "@autonoma/workflow";
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
        private readonly triggerAnalysisJob: (params: TriggerAnalysisJobParams) => Promise<void>,
        private readonly cancelAnalysisJob: (snapshotId: string) => Promise<void>,
    ) {
        super();
    }

    /**
     * Fire the shadow `investigation` agent in PARALLEL with the diffs job, behind its feature flag. It runs on
     * its OWN detached snapshot (a baseline clone never wired to a branch pointer) paired via
     * `investigationSnapshotId`, so its suite work never collides with the diffs snapshot's pending-generation set.
     *
     * Best-effort: this must never block or fail the diffs trigger, so errors are contained (logged). When the
     * branch has no baseline suite to fork from there is nothing to shadow.
     */
    private async maybeTriggerShadows(params: {
        diffsSnapshotId: string;
        branchId: string;
        organizationId: string;
        headSha: string;
        baseSha: string;
    }): Promise<void> {
        if (!env.INVESTIGATION_SHADOW_ENABLED) return;
        await this.startInvestigationShadow(params);
    }

    /**
     * Create the investigation shadow's own detached snapshot, pair it onto the diffs snapshot via
     * `investigationSnapshotId`, and start the investigation workflow on it. Never rejects: a failed
     * create/pair/start is contained so it never sinks the diffs trigger. When the branch has no baseline suite to
     * fork from there is nothing to shadow.
     */
    private async startInvestigationShadow(params: {
        diffsSnapshotId: string;
        branchId: string;
        organizationId: string;
        headSha: string;
        baseSha: string;
    }): Promise<void> {
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
                this.logger.info("No baseline suite; skipping investigation shadow", {
                    snapshot: { snapshotId: diffsSnapshotId },
                });
                return;
            }

            await this.db.branchSnapshot.update({
                where: { id: diffsSnapshotId },
                data: { investigationSnapshotId: created.snapshotId },
            });

            await this.triggerInvestigationJob({ snapshotId: created.snapshotId });
            this.logger.info("Investigation shadow triggered on detached snapshot", {
                snapshot: { snapshotId: created.snapshotId },
                extra: { diffsSnapshotId },
            });
        } catch (error) {
            this.logger.warn("Investigation shadow failed to start", {
                snapshot: { snapshotId: diffsSnapshotId },
                extra: { error: String(error) },
            });
        }
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

        await this.triggerInvestigationJob({ snapshotId: created.snapshotId });
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

        const deploymentId = await this.createDeployment({
            branchId: branch.id,
            organizationId,
            url,
            webhookUrl,
            webhookHeaders,
        });

        const snapshotId = await this.startAnalysisPipeline({
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

        const snapshotId = await this.startAnalysisPipeline({ branchId, organizationId, headSha, baseSha });

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

    /**
     * Create the branch's real pending snapshot and start the org's PR-analysis pipeline on it. Two paths, chosen
     * per-org (gated by the global master switch):
     *
     * - analysis disabled (default): the diffs job is the PR analysis. Create the snapshot with a DiffsJob, fire
     *   the diffs workflow, and fan out the inert investigation shadow.
     * - analysis enabled: the merged pipeline IS the org's PR analysis. Create the snapshot with an AnalysisJob,
     *   run the analysis pipeline on that real pending snapshot (it promotes + files bugs at finalize), and skip
     *   the diffs job AND the investigation shadow entirely.
     *
     * Returns the created snapshot id.
     */
    private async startAnalysisPipeline(params: {
        branchId: string;
        organizationId: string;
        headSha: string;
        baseSha: string;
    }): Promise<string> {
        const { branchId, organizationId, headSha, baseSha } = params;
        const analysisEnabled = await this.resolveAnalysisEnabled(organizationId);
        const snapshotId = await this.createSnapshot(branchId, organizationId, headSha, baseSha, analysisEnabled);

        if (analysisEnabled) {
            await this.triggerAnalysisJob({ snapshotId });
            this.logger.info("Analysis pipeline triggered on the real pending snapshot", {
                branchId,
                snapshot: { snapshotId },
            });
            return snapshotId;
        }

        await this.triggerDiffsJob({ branchId, snapshotId });
        await this.maybeTriggerShadows({ diffsSnapshotId: snapshotId, branchId, organizationId, headSha, baseSha });
        return snapshotId;
    }

    /**
     * Whether the merged analysis pipeline is this org's PR analysis. Requires BOTH the global master switch
     * (`ANALYSIS_AUTHORITATIVE_ENABLED`) and the org's own `analysisEnabled` setting; so the whole fleet stays on
     * diffs unless the switch is on, and even then only orgs deliberately flipped run analysis - and the switch
     * reverts every org at once.
     */
    private async resolveAnalysisEnabled(organizationId: string): Promise<boolean> {
        if (!env.ANALYSIS_AUTHORITATIVE_ENABLED) return false;
        const settings = await this.db.organizationSettings.findUnique({
            where: { organizationId },
            select: { analysisEnabled: true },
        });
        return settings?.analysisEnabled === true;
    }

    private async createSnapshot(
        branchId: string,
        organizationId: string,
        headSha: string,
        baseSha: string,
        analysisEnabled: boolean,
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
            await this.createJob(updater.snapshotId, organizationId, analysisEnabled);
            return updater.snapshotId;
        } catch (error) {
            if (!(error instanceof BranchAlreadyHasPendingSnapshotError)) throw error;

            this.logger.info("Superseding the pending snapshot and its in-flight pipeline", { branchId });

            const staleUpdater = await TestSuiteUpdater.continueUpdate({ db: this.db, branchId });
            await this.supersedeStalePipeline(staleUpdater.snapshotId);
            await staleUpdater.cancel();

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
            await this.createJob(updater.snapshotId, organizationId, analysisEnabled);
            return updater.snapshotId;
        }
    }

    /** Create the status-tracking job for the snapshot: an AnalysisJob when analysis runs, else a DiffsJob. */
    private async createJob(snapshotId: string, organizationId: string, analysisEnabled: boolean): Promise<void> {
        if (analysisEnabled) {
            await this.db.analysisJob.create({
                data: { snapshotId, organizationId, status: "running", startedAt: new Date() },
            });
            this.logger.info("AnalysisJob created", { snapshot: { snapshotId } });
            return;
        }
        await this.db.diffsJob.create({
            data: { snapshotId, organizationId, status: "pending" },
        });
        this.logger.info("DiffsJob created", { snapshotId });
    }

    /**
     * Cancel whatever pipeline was running on a superseded snapshot. Every step is a best-effort no-op when it
     * does not apply, so this is safe regardless of whether the stale run was a diffs run or an analysis run
     * (which may differ from the new one if the org's setting was flipped between pushes):
     *
     * - diffs run: the diffs workflow runs on this snapshot; the investigation shadow runs on its detached twin
     *   (cancelled via `supersedeShadows`). The DiffsJob is marked terminal.
     * - analysis run: the analysis workflow runs on THIS snapshot; the AnalysisJob is marked terminal. There is
     *   no diffs workflow, so that cancel is a no-op.
     */
    private async supersedeStalePipeline(staleSnapshotId: string): Promise<void> {
        // The three cancels hit independent targets (the diffs workflow, the analysis workflow, and the
        // investigation twin) and each is a contained no-op when its target does not exist, so fire them together;
        // allSettled so one failure never skips the others. This covers a stale run of either kind (which may
        // differ from the new one if the org's setting was flipped between pushes).
        await Promise.allSettled([
            this.cancelDiffsJob(staleSnapshotId),
            this.cancelAnalysisJob(staleSnapshotId),
            this.supersedeShadows(staleSnapshotId),
        ]);
        // Mark whichever job existed terminal - independent tables, both contained (updateMany no-ops on a miss).
        await Promise.all([
            this.markDiffsJobSuperseded(staleSnapshotId),
            this.markAnalysisJobSuperseded(staleSnapshotId),
        ]);
    }

    /**
     * Cancel the investigation shadow (if any) of a diffs snapshot being superseded: stop its in-flight workflow
     * on its detached twin (`investigationSnapshotId`) so it stops running against a soon-to-be-replaced preview,
     * and mark that twin `cancelled` so its state is terminal. Best-effort throughout - a not-found workflow is a
     * no-op and this never blocks the fresh diffs trigger.
     */
    private async supersedeShadows(staleDiffsSnapshotId: string): Promise<void> {
        try {
            const stale = await this.db.branchSnapshot.findUnique({
                where: { id: staleDiffsSnapshotId },
                select: { investigationSnapshotId: true },
            });
            const twinSnapshotId = stale?.investigationSnapshotId;
            if (twinSnapshotId == null) return;

            try {
                await this.cancelInvestigationJob(twinSnapshotId);
            } catch (error) {
                this.logger.warn("Investigation shadow cancel failed during supersession", {
                    snapshot: { snapshotId: twinSnapshotId },
                    extra: { error: String(error) },
                });
            }
            await this.db.branchSnapshot.update({
                where: { id: twinSnapshotId },
                data: { status: "cancelled" },
            });
            this.logger.info("Superseded investigation shadow snapshot cancelled", {
                snapshot: { snapshotId: twinSnapshotId },
                extra: { staleDiffsSnapshotId },
            });
        } catch (error) {
            this.logger.warn("Failed to supersede investigation shadow snapshot", {
                snapshot: { snapshotId: staleDiffsSnapshotId },
                extra: { error: String(error) },
            });
        }
    }

    private async markDiffsJobSuperseded(snapshotId: string): Promise<void> {
        try {
            // updateMany (not update) so it is a no-op rather than a throw when the stale run had no DiffsJob (an
            // authoritative run) - both mark helpers fire on every supersession regardless of the stale run's mode.
            const result = await this.db.diffsJob.updateMany({
                where: { snapshotId },
                data: {
                    status: "failed",
                    failureReason: "Superseded by a newer diffs request",
                    completedAt: new Date(),
                },
            });
            if (result.count > 0) this.logger.info("Stale DiffsJob marked as superseded", { snapshotId });
        } catch (error) {
            this.logger.warn("Failed to mark stale DiffsJob as superseded", { snapshotId, extra: { error } });
        }
    }

    /**
     * Mark a stale AnalysisJob terminal on supersession (authoritative runs). `updateMany` scoped to a still
     * `running` job so it is a no-op when the stale run had no AnalysisJob (a shadow run) or already finished -
     * never a throw.
     */
    private async markAnalysisJobSuperseded(snapshotId: string): Promise<void> {
        try {
            const result = await this.db.analysisJob.updateMany({
                where: { snapshotId, status: "running" },
                data: {
                    status: "failed",
                    failureReason: "Superseded by a newer analysis request",
                    completedAt: new Date(),
                },
            });
            if (result.count > 0) this.logger.info("Stale AnalysisJob marked as superseded", { snapshotId });
        } catch (error) {
            this.logger.warn("Failed to mark stale AnalysisJob as superseded", { snapshotId, extra: { error } });
        }
    }
}
