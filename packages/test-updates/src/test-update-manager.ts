import type { PrismaClient, TriggerSource } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import type { TestSuiteChange } from "./changes";
import { SnapshotDraft } from "./snapshot-draft";

interface TestSuiteUpdaterParams {
    snapshotDraft: SnapshotDraft;
}

interface StartUpdateArgs {
    db: PrismaClient;
    branchId: string;
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
    organizationId?: string;
}

interface ContinueUpdateBySnapshotArgs {
    db: PrismaClient;
    snapshotId: string;
    organizationId?: string;
}

/**
 * The test update manager handles the flow of updating the test suite based on changes
 * that were made to the application.
 */
export class TestSuiteUpdater {
    private readonly logger: Logger;

    private readonly snapshotDraft: SnapshotDraft;

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

    /** Which workflow opened this snapshot - the manual editor (`MANUAL`) or the analysis pipeline. */
    public get source() {
        return this.snapshotDraft.source;
    }

    private constructor({ snapshotDraft }: TestSuiteUpdaterParams) {
        this.logger = logger.child({ name: this.constructor.name, snapshotId: snapshotDraft.snapshotId });
        this.snapshotDraft = snapshotDraft;
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
     * @param params.organizationId - Optional. When provided, verifies the branch belongs to this organization.
     */
    public static async startUpdate({ db, branchId, organizationId, source, headSha, baseSha }: StartUpdateArgs) {
        const snapshotDraft = await SnapshotDraft.start({
            db,
            branchId,
            organizationId,
            source,
            headSha,
            baseSha,
        });

        return new TestSuiteUpdater({ snapshotDraft });
    }

    /**
     * Loads the existing pending snapshot and returns an updater for it.
     *
     * @param params.organizationId - Optional. When provided, verifies the branch belongs to this organization.
     */
    public static async continueUpdate({ db, branchId, organizationId }: ContinueUpdateArgs) {
        const snapshotDraft = await SnapshotDraft.loadPending({ db, branchId, organizationId });

        return new TestSuiteUpdater({ snapshotDraft });
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
    public static async continueUpdateBySnapshot({ db, snapshotId, organizationId }: ContinueUpdateBySnapshotArgs) {
        const snapshotDraft = await SnapshotDraft.loadById({ db, snapshotId, organizationId });

        return new TestSuiteUpdater({ snapshotDraft });
    }

    public async currentTestSuiteInfo() {
        return this.snapshotDraft.currentTestSuiteInfo();
    }

    public async apply<TResult>(change: TestSuiteChange<unknown, TResult>): Promise<TResult> {
        this.logger.info("Applying test suite change", { type: change.constructor.name });

        const result = await change.apply({ snapshotDraft: this.snapshotDraft });

        this.logger.info("Finished applying change");

        return result;
    }

    public async getChanges() {
        return this.snapshotDraft.getChanges();
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

    /** Fails the pending snapshot and clears its branch pending pointer. */
    public async fail() {
        this.logger.info("Failing snapshot");
        await this.snapshotDraft.fail();
        this.logger.info("Snapshot failed");
    }

    /** Finalizes the snapshot by activating it. */
    public async finalize() {
        this.logger.info("Finalizing snapshot");
        await this.snapshotDraft.activate();
        this.logger.info("Snapshot finalized and activated");
    }
}
