import type { PrismaClient } from "@autonoma/db";
import { TriggerSource } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import type { PipelineWorkflows } from "@autonoma/workflow";
import { BranchAlreadyHasPendingSnapshotError } from "../snapshot-draft";
import { TestSuiteUpdater } from "../test-update-manager";
import { createDetachedSnapshot } from "./create-detached-snapshot";

const DIFFS_SUPERSEDE_REASON = "Superseded by a newer diffs request";
const ANALYSIS_SUPERSEDE_REASON = "Superseded by a newer analysis request";

/**
 * The two env gates that pick the pipeline, injected (never read from an app's env inside this shared package) so
 * the API and the worker pass their own. `analysisAuthoritativeEnabled` is the global master switch for the
 * merged analysis pipeline; `investigationShadowEnabled` gates the diffs fallback's investigation shadow.
 */
export interface DiffsRunFlags {
    analysisAuthoritativeEnabled: boolean;
    investigationShadowEnabled: boolean;
}

export interface DiffsRunPreparerDeps {
    db: PrismaClient;
    logger: Logger;
    workflows: PipelineWorkflows;
    flags: DiffsRunFlags;
}

export interface PrepareDiffsRunParams {
    branchId: string;
    organizationId: string;
    headSha: string;
    baseSha: string;
    url: string;
    webhookUrl?: string;
    webhookHeaders?: Record<string, string>;
}

export type PrepareDiffsRunResult =
    | { skipped: true }
    | { skipped: false; snapshotId: string; deploymentId: string };

/**
 * The reusable "start a PR run" core, extracted from the API's DiffsTriggerService so the API webhook paths and
 * the PreviewKit-managed Temporal path run the exact same sequence (only the upstream branch/sha resolution
 * differs). Creates the branch deployment + the real pending snapshot, then starts the org's pipeline on it:
 *
 * - analysis disabled (default for the fleet): the diffs job is the PR analysis - a DiffsJob, the diffs workflow,
 *   and the inert investigation shadow.
 * - analysis enabled (per-org, behind the global switch): the merged analysis pipeline IS the PR analysis - an
 *   AnalysisJob, the analysis workflow on the real pending snapshot, and NO diffs job or investigation shadow.
 *
 * Superseding a branch's in-flight run cancels whichever pipeline was running (diffs or analysis) so a flip
 * between pushes is safe.
 */
export class DiffsRunPreparer {
    private readonly db: PrismaClient;
    private readonly logger: Logger;
    private readonly workflows: PipelineWorkflows;
    private readonly flags: DiffsRunFlags;

    constructor({ db, logger, workflows, flags }: DiffsRunPreparerDeps) {
        this.db = db;
        this.logger = logger;
        this.workflows = workflows;
        this.flags = flags;
    }

    async prepare({
        branchId,
        organizationId,
        headSha,
        baseSha,
        url,
        webhookUrl,
        webhookHeaders,
    }: PrepareDiffsRunParams): Promise<PrepareDiffsRunResult> {
        // Idempotency: a re-delivered signal for an already-analyzed head has
        // nothing new to diff. Drop it rather than superseding an in-flight run.
        if (headSha === baseSha) {
            this.logger.info("Skipping run: head already analyzed, no new commits", { branchId, headSha });
            return { skipped: true };
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
     * Create the branch's real pending snapshot and start the org's PR-analysis pipeline on it: the merged
     * analysis pipeline for an analysis-enabled org (promotes + files bugs at finalize), otherwise the diffs job
     * plus the inert investigation shadow. Returns the created snapshot id.
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
        const analysisEnabled = await this.resolveAnalysisEnabled(organizationId);
        const snapshotId = await this.createSnapshot(branchId, organizationId, headSha, baseSha, analysisEnabled);

        if (analysisEnabled) {
            await this.workflows.triggerAnalysis({ snapshotId });
            this.logger.info("Analysis pipeline triggered on the real pending snapshot", {
                branchId,
                snapshot: { snapshotId },
            });
            return snapshotId;
        }

        await this.workflows.triggerDiffs({ branchId, snapshotId });
        await this.maybeTriggerShadows({ diffsSnapshotId: snapshotId, branchId, organizationId, headSha, baseSha });
        return snapshotId;
    }

    /**
     * Whether the merged analysis pipeline is this org's PR analysis. Requires BOTH the global master switch and
     * the org's own `analysisEnabled` setting, so the fleet stays on diffs unless the switch is on, and even then
     * only deliberately-flipped orgs run analysis.
     */
    private async resolveAnalysisEnabled(organizationId: string): Promise<boolean> {
        if (!this.flags.analysisAuthoritativeEnabled) return false;
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
     * (which may differ from the new one if the org's setting was flipped between pushes).
     */
    private async supersedeStalePipeline(staleSnapshotId: string): Promise<void> {
        await Promise.allSettled([
            this.workflows.cancelDiffs(staleSnapshotId),
            this.workflows.cancelAnalysis(staleSnapshotId),
            this.supersedeShadows(staleSnapshotId),
        ]);
        await Promise.all([
            this.markDiffsJobSuperseded(staleSnapshotId),
            this.markAnalysisJobSuperseded(staleSnapshotId),
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

    private async markAnalysisJobSuperseded(snapshotId: string): Promise<void> {
        try {
            const result = await this.db.analysisJob.updateMany({
                where: { snapshotId, status: "running" },
                data: { status: "failed", failureReason: ANALYSIS_SUPERSEDE_REASON, completedAt: new Date() },
            });
            if (result.count > 0) this.logger.info("Stale AnalysisJob marked as superseded", { snapshotId });
        } catch (error) {
            this.logger.warn("Failed to mark stale AnalysisJob as superseded", { snapshotId, err: error });
        }
    }

    private async maybeTriggerShadows(params: {
        diffsSnapshotId: string;
        branchId: string;
        organizationId: string;
        headSha: string;
        baseSha: string;
    }): Promise<void> {
        if (!this.flags.investigationShadowEnabled) return;
        await this.startInvestigationShadow(params);
    }

    /**
     * Create the investigation shadow's own detached snapshot, pair it onto the diffs snapshot via
     * `investigationSnapshotId`, and start the investigation workflow on it. Never rejects: a failed
     * create/pair/start is contained so it never sinks the trigger.
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

            await this.workflows.triggerInvestigation({ snapshotId: created.snapshotId });
            this.logger.info("Investigation shadow triggered on detached snapshot", {
                snapshot: { snapshotId: created.snapshotId },
                extra: { diffsSnapshotId },
            });
        } catch (error) {
            this.logger.warn("Investigation shadow failed to start", {
                snapshot: { snapshotId: diffsSnapshotId },
                err: error,
            });
        }
    }
}
