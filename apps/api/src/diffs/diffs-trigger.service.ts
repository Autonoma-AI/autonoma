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
     * Fire the shadow workflows in PARALLEL with the diffs job, behind feature flags. Each shadow runs on its
     * OWN detached snapshot (a baseline clone never wired to a branch pointer): the legacy `investigation` agent
     * on the snapshot paired via `investigationSnapshotId`, and the merged `analysis` pipeline (which will
     * replace both diffs and investigation) on a SEPARATE snapshot paired via `analysisSnapshotId`. Giving each
     * shadow its own snapshot means their suite work never collides on a shared twin and never pollutes the
     * diffs snapshot's pending-generation set.
     *
     * Best-effort: this must never block or fail the diffs trigger, so errors are contained (logged). Each
     * shadow's detached snapshot is created independently; when the branch has no baseline suite to fork from
     * there is nothing to shadow.
     */
    private async maybeTriggerShadows(params: {
        diffsSnapshotId: string;
        branchId: string;
        organizationId: string;
        headSha: string;
        baseSha: string;
    }): Promise<void> {
        if (!env.INVESTIGATION_SHADOW_ENABLED && !env.ANALYSIS_SHADOW_ENABLED) return;
        const { diffsSnapshotId, branchId, organizationId, headSha, baseSha } = params;

        // Independent shadows on independent snapshots - fire them concurrently. Each start is contained and
        // never rejects, so one failing shadow never skips the other and neither sinks the diffs trigger.
        const starts: Promise<void>[] = [];
        if (env.INVESTIGATION_SHADOW_ENABLED) {
            starts.push(
                this.startShadowOnOwnSnapshot({
                    name: "investigation",
                    diffsSnapshotId,
                    branchId,
                    organizationId,
                    headSha,
                    baseSha,
                    pair: (snapshotId) => ({ investigationSnapshotId: snapshotId }),
                    start: (snapshotId) => this.triggerInvestigationJob({ snapshotId }),
                }),
            );
        }
        if (env.ANALYSIS_SHADOW_ENABLED) {
            starts.push(
                this.startShadowOnOwnSnapshot({
                    name: "analysis",
                    diffsSnapshotId,
                    branchId,
                    organizationId,
                    headSha,
                    baseSha,
                    pair: (snapshotId) => ({ analysisSnapshotId: snapshotId }),
                    start: (snapshotId) => this.triggerAnalysisJob({ snapshotId, mode: "shadow" }),
                }),
            );
        }
        await Promise.all(starts);
    }

    /**
     * Create one shadow's own detached snapshot, pair it onto the diffs snapshot via the shadow's pointer, and
     * start the shadow workflow on it. Never rejects: a failed create/pair/start is contained so it cannot skip a
     * sibling shadow running concurrently, and it must never sink the diffs trigger. When the branch has no
     * baseline suite to fork from there is nothing to shadow.
     */
    private async startShadowOnOwnSnapshot(params: {
        name: string;
        diffsSnapshotId: string;
        branchId: string;
        organizationId: string;
        headSha: string;
        baseSha: string;
        /** The diffs-snapshot pointer that pairs it to this shadow's detached snapshot. */
        pair: (snapshotId: string) => { investigationSnapshotId: string } | { analysisSnapshotId: string };
        start: (snapshotId: string) => Promise<void>;
    }): Promise<void> {
        const { name, diffsSnapshotId, branchId, organizationId, headSha, baseSha } = params;
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
                this.logger.info("No baseline suite; skipping shadow workflow", {
                    snapshot: { snapshotId: diffsSnapshotId },
                    extra: { shadow: name },
                });
                return;
            }

            await this.db.branchSnapshot.update({
                where: { id: diffsSnapshotId },
                data: params.pair(created.snapshotId),
            });

            await params.start(created.snapshotId);
            this.logger.info("Shadow workflow triggered on detached snapshot", {
                snapshot: { snapshotId: created.snapshotId },
                extra: { shadow: name, diffsSnapshotId },
            });
        } catch (error) {
            this.logger.warn("Shadow workflow failed to start", {
                snapshot: { snapshotId: diffsSnapshotId },
                extra: { shadow: name, error: String(error) },
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

        const snapshotId = await this.createSnapshot(branch.id, organizationId, headSha, baseSha);

        await this.triggerDiffsJob({ branchId: branch.id, snapshotId });
        await this.maybeTriggerShadows({
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
        await this.maybeTriggerShadows({
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
            await this.supersedeShadows(staleUpdater.snapshotId);
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
     * Cancel the shadow snapshots (if any) of a diffs snapshot being superseded. Each shadow now runs on its OWN
     * detached snapshot, so stop each in-flight workflow on its own snapshot (investigation on
     * `investigationSnapshotId`, analysis on `analysisSnapshotId`) so neither keeps running against a
     * soon-to-be-replaced preview, and mark each detached snapshot `cancelled` so its state is terminal. Every
     * cancel is unconditional (best-effort, a not-found workflow is a no-op) so a flag flipped between trigger
     * and supersede never strands a run. Best-effort throughout - never blocks the fresh diffs trigger.
     */
    private async supersedeShadows(staleDiffsSnapshotId: string): Promise<void> {
        try {
            const stale = await this.db.branchSnapshot.findUnique({
                where: { id: staleDiffsSnapshotId },
                select: { investigationSnapshotId: true, analysisSnapshotId: true },
            });
            if (stale == null) return;

            // Independent best-effort supersedes on independent snapshots - run concurrently. allSettled so a
            // failure in one neither delays nor skips the other.
            await Promise.allSettled([
                this.supersedeShadowSnapshot(
                    "investigation",
                    stale.investigationSnapshotId,
                    staleDiffsSnapshotId,
                    this.cancelInvestigationJob,
                ),
                this.supersedeShadowSnapshot(
                    "analysis",
                    stale.analysisSnapshotId,
                    staleDiffsSnapshotId,
                    this.cancelAnalysisJob,
                ),
            ]);
        } catch (error) {
            this.logger.warn("Failed to supersede shadow snapshots", {
                snapshot: { snapshotId: staleDiffsSnapshotId },
                extra: { error: String(error) },
            });
        }
    }

    /**
     * Cancel one shadow's in-flight workflow on its detached snapshot and mark that snapshot `cancelled`. No-op
     * when the shadow was never paired (its pointer is null). Contained so a cancel failure still writes the
     * terminal status and never blocks the sibling shadow's supersede.
     */
    private async supersedeShadowSnapshot(
        name: string,
        shadowSnapshotId: string | null,
        staleDiffsSnapshotId: string,
        cancel: (snapshotId: string) => Promise<void>,
    ): Promise<void> {
        if (shadowSnapshotId == null) return;
        try {
            await cancel(shadowSnapshotId);
        } catch (error) {
            this.logger.warn("A shadow workflow cancel failed during supersession", {
                snapshot: { snapshotId: shadowSnapshotId },
                extra: { shadow: name, error: String(error) },
            });
        }
        await this.db.branchSnapshot.update({
            where: { id: shadowSnapshotId },
            data: { status: "cancelled" },
        });
        this.logger.info("Superseded shadow snapshot cancelled", {
            snapshot: { snapshotId: shadowSnapshotId },
            extra: { shadow: name, staleDiffsSnapshotId },
        });
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
