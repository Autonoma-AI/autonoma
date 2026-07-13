import type { PrismaClient, TriggerSource } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import type { TestSuiteChange } from "./changes";
import type { GenerationProvider } from "./generation/generation-job-provider";
import { GenerationManager } from "./generation/generation-manager";
import { SnapshotDraft } from "./snapshot-draft";

export { MissingJobProviderError } from "./generation/generation-manager";

export class IncompleteGenerationsError extends Error {
    constructor(snapshotId: string) {
        super(`Cannot finalize snapshot ${snapshotId}: there are still incomplete generations`);
        this.name = "IncompleteGenerationsError";
    }
}

interface TestSuiteUpdaterParams {
    snapshotDraft: SnapshotDraft;
    generationManager: GenerationManager;
}

interface StartUpdateArgs {
    db: PrismaClient;
    branchId: string;
    jobProvider?: GenerationProvider;
    organizationId?: string;
    source?: TriggerSource;
    /** The SHA of the head commit to update the test suite for. */
    headSha?: string;
    /** The SHA of the base (previous) commit to update the test suite for. */
    baseSha?: string;
}

interface ContinueUpdateArgs {
    db: PrismaClient;
    branchId: string;
    jobProvider?: GenerationProvider;
    organizationId?: string;
}

interface ContinueUpdateBySnapshotArgs {
    db: PrismaClient;
    snapshotId: string;
    jobProvider?: GenerationProvider;
    organizationId?: string;
}

/**
 * The test update manager handles the flow of updating the test suite based on changes
 * that were made to the application.
 */
export class TestSuiteUpdater {
    private readonly logger: Logger;

    private readonly snapshotDraft: SnapshotDraft;
    private readonly generationManager: GenerationManager;

    public get snapshotId() {
        return this.snapshotDraft.snapshotId;
    }

    public get branchId() {
        return this.snapshotDraft.branchId;
    }

    public get applicationId() {
        return this.snapshotDraft.applicationId;
    }

    public get organizationId() {
        return this.snapshotDraft.organizationId;
    }

    private constructor({ snapshotDraft, generationManager }: TestSuiteUpdaterParams) {
        this.logger = logger.child({ name: this.constructor.name, snapshotId: snapshotDraft.snapshotId });
        this.snapshotDraft = snapshotDraft;
        this.generationManager = generationManager;
    }

    public get headSha(): string | undefined {
        return this.snapshotDraft.headSha;
    }

    public get baseSha(): string | undefined {
        return this.snapshotDraft.baseSha;
    }

    /**
     * Creates a new pending snapshot and returns an updater for it.
     *
     * @param params.commitDiffHandler - Optional. When provided, enables commit recheck on finalize.
     * @param params.organizationId - Optional. When provided, verifies the branch belongs to this organization.
     */
    public static async startUpdate({
        db,
        branchId,
        jobProvider,
        organizationId,
        source,
        headSha,
        baseSha,
    }: StartUpdateArgs) {
        const snapshotDraft = await SnapshotDraft.start({
            db,
            branchId,
            organizationId,
            source,
            headSha,
            baseSha,
        });

        return new TestSuiteUpdater({
            snapshotDraft,
            generationManager: new GenerationManager({
                db,
                snapshotId: snapshotDraft.snapshotId,
                organizationId: snapshotDraft.organizationId,
                jobProvider,
            }),
        });
    }

    /**
     * Loads the existing pending snapshot and returns an updater for it.
     *
     * @param params.commitDiffHandler - Optional. When provided, enables commit recheck on finalize.
     * @param params.organizationId - Optional. When provided, verifies the branch belongs to this organization.
     */
    public static async continueUpdate({ db, branchId, jobProvider, organizationId }: ContinueUpdateArgs) {
        const snapshotDraft = await SnapshotDraft.loadPending({ db, branchId, organizationId });

        return new TestSuiteUpdater({
            snapshotDraft,
            generationManager: new GenerationManager({
                db,
                snapshotId: snapshotDraft.snapshotId,
                organizationId: snapshotDraft.organizationId,
                jobProvider,
            }),
        });
    }

    /**
     * Loads a specific pending snapshot by ID and returns an updater for it.
     *
     * Use this when you need to operate on a known snapshot (e.g. inside a
     * workflow activity that was dispatched for a specific snapshot) rather than
     * "whatever is currently pending on the branch."
     *
     * @throws {SnapshotNotPendingError} If the snapshot is not in "processing" status.
     */
    public static async continueUpdateBySnapshot({
        db,
        snapshotId,
        jobProvider,
        organizationId,
    }: ContinueUpdateBySnapshotArgs) {
        const snapshotDraft = await SnapshotDraft.loadById({ db, snapshotId, organizationId });

        return new TestSuiteUpdater({
            snapshotDraft,
            generationManager: new GenerationManager({
                db,
                snapshotId: snapshotDraft.snapshotId,
                organizationId: snapshotDraft.organizationId,
                jobProvider,
            }),
        });
    }

    public async currentTestSuiteInfo() {
        return this.snapshotDraft.currentTestSuiteInfo();
    }

    public async apply<TResult>(change: TestSuiteChange<unknown, TResult>): Promise<TResult> {
        this.logger.info("Applying test suite change", { type: change.constructor.name });

        const result = await change.apply({
            snapshotDraft: this.snapshotDraft,
            generationManager: this.generationManager,
        });

        this.logger.info("Finished applying change");

        return result;
    }

    /**
     * Fires generation jobs for all pending generations and marks them as queued.
     *
     * Delegates to the generation manager for validation, job firing, and status updates.
     * Fire-and-forget - the caller does not wait for the dispatched batch to complete.
     *
     * @throws {MissingJobProviderError} If no job provider was supplied at construction time.
     */
    public async queuePendingGenerations() {
        this.logger.info("Queueing pending generations");

        const result = await this.generationManager.queuePendingGenerations();

        this.logger.info("Pending generations queued", { generationsQueued: result.generationsQueued });

        return result;
    }

    /**
     * Validates deployment, marks pending generations as queued, and returns the
     * list ready for dispatch. Use this when the caller (e.g. a Temporal workflow)
     * will spawn the generation workflow itself rather than going through the
     * provider's fire-and-forget path.
     */
    public async prepareGenerationQueue() {
        this.logger.info("Preparing generation queue");

        const prepared = await this.generationManager.prepareGenerationQueue();

        this.logger.info("Generation queue prepared", { count: prepared.length });

        return prepared;
    }

    /**
     * Assigns generation results to the snapshot.
     *
     * Loads completed generations, assigns step input lists from successful ones
     * to the corresponding test case assignments.
     * Failed generations are skipped (their assignments keep stepsId as null).
     */
    public async assignGenerationResults(generationIds: string[]) {
        this.logger.info("Assigning generation results", { generationIds });

        const generations = await this.generationManager.getGenerations(generationIds);

        const successfulUpdates: Array<{ testCaseId: string; stepsId: string }> = [];
        let failed = 0;

        for (const generation of generations) {
            if (generation.status === "success" && generation.stepsId != null) {
                this.logger.info("Generation succeeded", {
                    generationId: generation.id,
                    testCaseId: generation.testPlan.testCaseId,
                    stepsId: generation.stepsId,
                });
                successfulUpdates.push({
                    testCaseId: generation.testPlan.testCaseId,
                    stepsId: generation.stepsId,
                });
            } else {
                this.logger.warn("Skipping failed generation", {
                    generationId: generation.id,
                    status: generation.status,
                });
                failed++;
            }
        }

        if (successfulUpdates.length > 0) {
            await this.snapshotDraft.updateManySteps(successfulUpdates);
        }

        this.logger.info("Generation results assigned", { assigned: successfulUpdates.length, failed });

        return { assigned: successfulUpdates.length, failed };
    }

    /** Returns all pending generation records for this snapshot. */
    public async getPendingGenerations() {
        return this.generationManager.getPendingGenerations();
    }

    /** Discards a single pending generation by ID. */
    public async discardGeneration(generationId: string) {
        this.logger.info("Discarding generation", { generationId });
        await this.generationManager.discardGeneration(generationId);
        this.logger.info("Generation discarded", { generationId });
    }

    public async getChanges() {
        return this.snapshotDraft.getChanges();
    }

    public async getGenerationSummary() {
        return this.generationManager.getGenerationSummary();
    }

    /**
     * Cancels the pending snapshot, marking it "cancelled" and clearing the
     * branch pointer while preserving its assignments, generations, and runs.
     */
    public async cancel() {
        this.logger.info("Cancelling snapshot");
        await this.snapshotDraft.cancel();
        this.logger.info("Snapshot cancelled");
    }

    /**
     * Finalizes the snapshot by activating it.
     *
     * Validates that there are no incomplete (pending, queued, or running)
     * generations before activation.
     *
     * @param discardPendingGenerations - When true, delete any `pending`
     *   generation jobs first so they don't block activation. Used to activate a
     *   snapshot without running its generations (onboarding), which also clears
     *   pending jobs left on snapshots created before onboarding stopped
     *   scheduling them. `queued`/`running` generations still block - those
     *   represent work in flight, not deferred jobs.
     * @throws {IncompleteGenerationsError} If incomplete generations remain after the optional discard.
     */
    public async finalize({ discardPendingGenerations = false }: { discardPendingGenerations?: boolean } = {}) {
        this.logger.info("Finalizing snapshot", { discardPendingGenerations });

        if (discardPendingGenerations) {
            await this.generationManager.discardPendingGenerations();
        }

        const hasIncomplete = await this.generationManager.hasIncompleteGenerations();
        if (hasIncomplete) {
            this.logger.fatal("Cannot finalize snapshot with incomplete generations");
            throw new IncompleteGenerationsError(this.snapshotDraft.snapshotId);
        }

        await this.snapshotDraft.activate();
        this.logger.info("Snapshot finalized and activated");
    }
}
