import type { PrismaClient } from "@autonoma/db";
import { TriggerSource } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import type { PipelineWorkflows } from "@autonoma/workflow";
import { BranchAlreadyHasPendingSnapshotError } from "../snapshot-draft";
import { TestSuiteUpdater } from "../test-update-manager";
import { settleAnalysisRunState } from "./settle-analysis-run-state";

const DIFFS_SUPERSEDE_REASON = "Superseded by a newer diffs request";
const ANALYSIS_SUPERSEDE_REASON = "Superseded by a newer analysis request";

export interface DiffsRunPreparerDeps {
    db: PrismaClient;
    logger: Logger;
    workflows: PipelineWorkflows;
}

export interface PrepareDiffsRunParams {
    branchId: string;
    organizationId: string;
    headSha: string;
    baseSha: string;
    url: string;
    webhookUrl?: string;
    webhookHeaders?: Record<string, string>;
    /**
     * True when a run was explicitly requested (a merge-gate trigger like `/start analysis`), which bypasses the
     * activation gate.
     */
    requested?: boolean;
    /**
     * True when this is a main-branch baseline run, which the activation gate never touches. Activation only
     * suppresses automatic PR analysis; a migrated org's baseline snapshot must keep updating on main pushes,
     * otherwise every later PR diff would compute against a stale base. Default false (a PR run).
     */
    isMainBranchRun?: boolean;
}

export type PrepareDiffsRunResult = { skipped: true } | { skipped: false; snapshotId: string; deploymentId: string };

/**
 * The reusable "start a PR run" core, extracted from the API's DiffsTriggerService so the API webhook paths and
 * the PreviewKit-managed Temporal path run the exact same sequence (only the upstream branch/sha resolution
 * differs). Creates the branch deployment + the real pending snapshot, then starts the merged analysis pipeline
 * on it: an AnalysisJob plus the analysis workflow, which promotes the snapshot at finalize.
 *
 * Analysis is the only PR-analysis pipeline - there is no per-org or env choice to make here. Supersession still
 * closes out a pre-cutover diffs run (see {@link supersedeStalePipeline}), because a branch whose pending
 * snapshot came from one must still be unblocked by the next push.
 */
export class DiffsRunPreparer {
    private readonly db: PrismaClient;
    private readonly logger: Logger;
    private readonly workflows: PipelineWorkflows;

    constructor({ db, logger, workflows }: DiffsRunPreparerDeps) {
        this.db = db;
        this.logger = logger;
        this.workflows = workflows;
    }

    async prepare({
        branchId,
        organizationId,
        headSha,
        baseSha,
        url,
        webhookUrl,
        webhookHeaders,
        requested,
        isMainBranchRun,
    }: PrepareDiffsRunParams): Promise<PrepareDiffsRunResult> {
        // Idempotency: a re-delivered signal for an already-analyzed head has
        // nothing new to diff. Drop it rather than superseding an in-flight run.
        if (headSha === baseSha) {
            this.logger.info("Skipping run: head already analyzed, no new commits", { branchId, headSha });
            return { skipped: true };
        }

        // Activation gate: an org that is migrated to activation never starts an automatic PR run on its own. The
        // automatic PR callers reach here with `requested !== true` and are suppressed; a run begins only when a
        // merge-gate trigger sets `requested: true`. The one exception is a repo that opted into the
        // auto-run-on-ready trigger: for it, this automatic preview-ready run IS the trigger, so it proceeds. This
        // is why ready-for-review fires here, not from the `pull_request.ready_for_review` webhook - the preview
        // does not exist yet at webhook time (it is built in response to it); this runs once it is live.
        const isSuppressibleAutomaticPrRun = isMainBranchRun !== true && requested !== true;
        let isAutoRunOnReady = false;
        if (isSuppressibleAutomaticPrRun && (await this.isActivationGated(organizationId))) {
            isAutoRunOnReady = await this.autoRunsOnReady(branchId);
            if (!isAutoRunOnReady) {
                this.logger.info("Activation: suppressing automatic run; a run starts only on an explicit request", {
                    branchId,
                    extra: { organizationId, headSha },
                });
                return { skipped: true };
            }
            this.logger.info("Activation: repo opted into auto-run-on-ready; proceeding with the automatic run", {
                branchId,
                extra: { organizationId, headSha },
            });
        }

        // Dedupe of activation triggers racing on the same head: attach to the pending snapshot an earlier trigger
        // created instead of superseding it. This covers explicit-vs-explicit (e.g. a label added while a
        // `/start analysis` comment is mid-run) AND auto-vs-explicit (a preview-ready auto-run firing just after a
        // `/start analysis` created a pending snapshot).
        if (requested === true || isAutoRunOnReady) {
            const inFlight = await this.findInFlightRunForHead(branchId, headSha);
            if (inFlight != null) {
                this.logger.info("Attaching to the in-flight run for this head; not starting a duplicate", {
                    branchId,
                    snapshot: { snapshotId: inFlight.snapshotId },
                    extra: { headSha, requested: requested === true, isAutoRunOnReady },
                });
                return { skipped: false, snapshotId: inFlight.snapshotId, deploymentId: inFlight.deploymentId };
            }
        }

        // Kept sequential on purpose (not Promise.all): both mutate the branch row - createDeployment updates
        // `branch.deploymentId`, and the snapshot creation inside startAnalysisPipeline takes a `SELECT ... FOR
        // UPDATE` lock on it - so running them concurrently only contends on that lock (and risks a deadlock)
        // for no real gain.
        const deploymentId = await this.createDeployment({ branchId, organizationId, url, webhookUrl, webhookHeaders });
        const snapshotId = await this.startAnalysisPipeline({ branchId, organizationId, headSha, baseSha });

        this.logger.info("PR run prepared and started", { branchId, snapshotId, deploymentId, headSha, baseSha });
        return { skipped: false, snapshotId, deploymentId };
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
     * Create the branch's real pending snapshot and start the analysis pipeline on it (it promotes the snapshot
     * and files its findings at finalize). Returns the created snapshot id.
     */
    private async startAnalysisPipeline({
        branchId,
        organizationId,
        headSha,
        baseSha,
    }: {
        branchId: string;
        organizationId: string;
        headSha: string;
        baseSha: string;
    }): Promise<string> {
        const snapshotId = await this.createSnapshot(branchId, organizationId, headSha, baseSha);

        await this.workflows.triggerAnalysis({ snapshotId });
        this.logger.info("Analysis pipeline triggered on the real pending snapshot", {
            branchId,
            snapshot: { snapshotId },
        });
        return snapshotId;
    }

    /**
     * The branch's in-flight run for `headSha`, if any: its pending (processing) snapshot whose head matches, plus
     * the branch's current deployment. Returns undefined when there is no pending snapshot, it is for a different
     * head (a newer push, which must supersede rather than attach), or the branch has no deployment yet.
     */
    private async findInFlightRunForHead(
        branchId: string,
        headSha: string,
    ): Promise<{ snapshotId: string; deploymentId: string } | undefined> {
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
        return { snapshotId: pending.id, deploymentId: branch.deploymentId };
    }

    /**
     * Whether this org is migrated to activation, in which case an automatic run is suppressed.
     */
    private async isActivationGated(organizationId: string): Promise<boolean> {
        const settings = await this.db.organizationSettings.findUnique({
            where: { organizationId },
            select: { activationEnabled: true },
        });
        return settings?.activationEnabled === true;
    }

    /**
     * Whether the branch's app opted into the auto-run-on-ready trigger. Under activation this is what lets an
     * automatic preview-ready run through the gate - it is the ready-for-review trigger, fired at the only moment
     * the preview is actually live.
     */
    private async autoRunsOnReady(branchId: string): Promise<boolean> {
        const branch = await this.db.branch.findUnique({
            where: { id: branchId },
            select: { application: { select: { triggerConfig: { select: { autoRunOnReadyForReview: true } } } } },
        });
        return branch?.application.triggerConfig?.autoRunOnReadyForReview === true;
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
            await this.createJob(updater.snapshotId, organizationId);
            return updater.snapshotId;
        } catch (error) {
            if (!(error instanceof BranchAlreadyHasPendingSnapshotError)) throw error;

            this.logger.info("Superseding the pending snapshot and its in-flight pipeline", { branchId });

            const staleUpdater = await TestSuiteUpdater.continueUpdate({ db: this.db, branchId });
            await this.supersedeStalePipeline(staleUpdater.snapshotId);

            this.logger.info("Stale snapshot settled, starting fresh update", {
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
            await this.createJob(updater.snapshotId, organizationId);
            return updater.snapshotId;
        }
    }

    /** Create the snapshot's status-tracking AnalysisJob. */
    private async createJob(snapshotId: string, organizationId: string): Promise<void> {
        // Only the job is created up-front; Investigators persist findings against it during fan-out. The
        // AnalysisReport is authored later by the Reporter, so a report's existence means the Reporter ran.
        await this.db.analysisJob.create({
            data: { snapshotId, organizationId, status: "running", startedAt: new Date() },
        });
        this.logger.info("AnalysisJob created", { snapshot: { snapshotId } });
    }

    /**
     * Cancel whatever pipeline was running on a superseded snapshot. Every step is a best-effort no-op when it
     * does not apply, which is what makes this safe for a stale snapshot from either pipeline: a pending snapshot
     * created before the diffs cutover still has a diffs run (and possibly an investigation shadow) to close, and
     * nothing else unblocks that branch. Drop the diffs/shadow steps once Temporal reports no `diffsAnalysisWorkflow`
     * or `investigationWorkflow` executions - they never self-reap, `triggerDiffsJob` set no execution timeout.
     */
    private async supersedeStalePipeline(staleSnapshotId: string): Promise<void> {
        await Promise.allSettled([
            this.workflows.cancelDiffs(staleSnapshotId),
            this.workflows.cancelAnalysis(staleSnapshotId),
            this.supersedeShadows(staleSnapshotId),
        ]);
        await Promise.all([
            this.markDiffsJobSuperseded(staleSnapshotId),
            settleAnalysisRunState({
                db: this.db,
                snapshotId: staleSnapshotId,
                outcome: { kind: "superseded", reason: ANALYSIS_SUPERSEDE_REASON },
            }),
        ]);
    }

    /**
     * Cancel the investigation shadow (if any) of a diffs snapshot being superseded: stop its in-flight workflow
     * on its detached twin and mark that twin `cancelled`. Best-effort throughout - a not-found workflow is a
     * no-op and this never blocks the fresh trigger.
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
                await this.workflows.cancelInvestigation(twinSnapshotId);
            } catch (error) {
                this.logger.warn("Investigation shadow cancel failed during supersession", {
                    snapshot: { snapshotId: twinSnapshotId },
                    err: error,
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
                err: error,
            });
        }
    }

    private async markDiffsJobSuperseded(snapshotId: string): Promise<void> {
        try {
            const result = await this.db.diffsJob.updateMany({
                where: { snapshotId },
                data: { status: "failed", failureReason: DIFFS_SUPERSEDE_REASON, completedAt: new Date() },
            });
            if (result.count > 0) this.logger.info("Stale DiffsJob marked as superseded", { snapshotId });
        } catch (error) {
            this.logger.warn("Failed to mark stale DiffsJob as superseded", { snapshotId, err: error });
        }
    }
}
