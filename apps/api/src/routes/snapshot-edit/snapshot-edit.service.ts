import type { BillingService } from "@autonoma/billing";
import type { ApplicationArchitecture, PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import {
    BranchAlreadyOpenError,
    BranchNotFoundError,
    EDIT_SNAPSHOT_TRIGGER,
    type OpenSnapshot,
    type Suite,
    type SuiteChange,
    type SuiteRun,
    SnapshotNotFoundError,
    SnapshotNotOpenError,
    TestSuiteStore,
} from "@autonoma/test-suite";
import type { TestPlanItem, TriggerBatchGenerationParams, WorkflowArchitecture, WorkflowRef } from "@autonoma/workflow";
import { Service } from "../service";
import { AnalysisInFlightError, EditSessionAlreadyOpenError, EditSessionSupersededError } from "./edit-session-errors";
import { assertBranchCanRun, TestsNotRunnableError } from "./run-preconditions";

/** What a run that could not be dispatched records, in place of a result the customer will never get. */
const DISPATCH_FAILURE_REASONING = "Could not be started. Contact the Autonoma team for help.";

interface AddTestInput {
    name: string;
    plan: string;
    folderId: string;
    description: string;
    scenarioId?: string;
}

interface AddTestsInput {
    tests: Array<{ name: string; plan: string; folderId: string; description: string }>;
    scenarioId?: string;
}

interface UpdateTestInput {
    testCaseId: string;
    plan: string;
    scenarioId?: string;
}

/**
 * What the branch's single pending-snapshot slot currently holds, from the editor's point of view. `open` carries
 * the snapshot id every subsequent call addresses, so no operation ever resolves "whatever is pending".
 */
type EditSessionState = { state: "none" } | { state: "open"; snapshotId: string } | { state: "analysis-in-flight" };

/**
 * The manual test-suite editor: one open snapshot per branch, addressed by id, that a user edits and then either
 * promotes or discards.
 *
 * Editing the suite never starts a run. A run is one execution of a test's plan and the customer is charged for
 * it, so it begins only where the user asked for one - {@link startRuns} - and the credit is deducted against the
 * run it started rather than swept up later.
 */
export class SnapshotEditService extends Service {
    private readonly suite: TestSuiteStore;

    constructor(
        private readonly db: PrismaClient,
        private readonly startGenerationBatch: (params: TriggerBatchGenerationParams) => Promise<WorkflowRef>,
        private readonly billingService: BillingService,
    ) {
        super();
        this.suite = new TestSuiteStore(db);
    }

    /**
     * Resolves the branch's editing state. This is the only branch-addressed call: it is how a client discovers
     * the snapshot id its session owns, and how it learns that an analysis has taken the slot.
     */
    async getState(branchId: string, organizationId: string): Promise<EditSessionState> {
        this.logger.info("Resolving edit session state", { branchId });

        const branch = await this.db.branch.findUnique({
            where: { id: branchId, organizationId },
            select: { pendingSnapshot: { select: { id: true, status: true, source: true } } },
        });
        if (branch == null) throw new NotFoundError("Branch not found");

        const pending = branch.pendingSnapshot;
        if (pending == null || pending.status !== "processing") {
            this.logger.info("Branch has no open snapshot", { branchId });
            return { state: "none" };
        }

        if (pending.source !== EDIT_SNAPSHOT_TRIGGER) {
            this.logger.info("Branch's open snapshot belongs to the analysis pipeline", {
                branchId,
                snapshotId: pending.id,
            });
            return { state: "analysis-in-flight" };
        }

        this.logger.info("Branch has an open edit session", { branchId, snapshotId: pending.id });
        return { state: "open", snapshotId: pending.id };
    }

    async startEditSession(branchId: string, organizationId: string) {
        this.logger.info("Starting edit session", { branchId });

        const snapshot = await this.openEditSnapshot(branchId, organizationId);
        const testSuite = await snapshot.read();

        this.logger.info("Edit session started", { branchId, snapshotId: snapshot.snapshotId });

        return { snapshotId: snapshot.snapshotId, testSuite };
    }

    async getEditSession(snapshotId: string, organizationId: string) {
        this.logger.info("Getting edit session", { snapshotId });

        const snapshot = await this.editSession(snapshotId, organizationId);
        const [testSuite, changes, runs] = await Promise.all([
            snapshot.read(),
            this.suite.changesSince(snapshotId),
            this.suite.latestRunPerTest(snapshotId),
        ]);

        return {
            snapshotId: snapshot.snapshotId,
            testSuite,
            changes,
            runs,
            testsAwaitingRun: testsAwaitingRun(changes, runs),
        };
    }

    async addTest(snapshotId: string, input: AddTestInput, organizationId: string) {
        this.logger.info("Adding test to edit session", { snapshotId, name: input.name });

        const snapshot = await this.editSession(snapshotId, organizationId);
        await snapshot.addTest(input);

        this.logger.info("Test added to edit session", { snapshotId });
    }

    async addTests(snapshotId: string, input: AddTestsInput, organizationId: string) {
        this.logger.info("Adding bulk tests to edit session", { snapshotId, count: input.tests.length });

        const snapshot = await this.editSession(snapshotId, organizationId);
        for (const test of input.tests) {
            await snapshot.addTest({
                name: test.name,
                description: test.description,
                plan: test.plan,
                folderId: test.folderId,
                scenarioId: input.scenarioId,
            });
        }

        this.logger.info("Bulk tests added to edit session", { snapshotId, count: input.tests.length });
    }

    async updateTest(snapshotId: string, input: UpdateTestInput, organizationId: string) {
        this.logger.info("Updating test in edit session", { snapshotId, testCaseId: input.testCaseId });

        const snapshot = await this.editSession(snapshotId, organizationId);
        await snapshot.revisePlan(input);

        this.logger.info("Test updated in edit session", { snapshotId, testCaseId: input.testCaseId });
    }

    async removeTest(snapshotId: string, testCaseId: string, organizationId: string) {
        this.logger.info("Removing test from edit session", { snapshotId, testCaseId });

        const snapshot = await this.editSession(snapshotId, organizationId);
        await snapshot.dropTest(testCaseId);

        this.logger.info("Test removed from edit session", { snapshotId, testCaseId });
    }

    async discardChange(snapshotId: string, testCaseId: string, organizationId: string) {
        this.logger.info("Discarding change for test case", { snapshotId, testCaseId });

        const snapshot = await this.editSession(snapshotId, organizationId);
        await snapshot.discardTest(testCaseId);

        this.logger.info("Change discarded for test case", { snapshotId, testCaseId });
    }

    /**
     * Start one run of each listed test's pinned plan and dispatch them. The only place the editor creates a run,
     * and the only place it charges: the credit is deducted per run started, keyed on the run's own id, so a
     * retried request re-deducts nothing.
     */
    async startRuns(snapshotId: string, testCaseIds: string[], organizationId: string) {
        this.logger.info("Starting runs for edit session", { snapshotId, count: testCaseIds.length });

        const snapshot = await this.editSession(snapshotId, organizationId);
        // Every precondition is checked before the first run exists, so a refused request charges nothing and
        // leaves no half-started column behind.
        const [architecture, suite] = await Promise.all([this.runnableArchitecture(snapshot), snapshot.read()]);
        assertTestsRunnable(suite, testCaseIds);
        await this.billingService.checkCreditsGate(organizationId, testCaseIds.length, architecture);

        const testPlans: TestPlanItem[] = [];
        for (const testCaseId of testCaseIds) {
            const { runId, scenarioId } = await snapshot.startRun(testCaseId);
            await this.billingService.deductCreditsForGeneration(runId, { organizationId, architecture });
            testPlans.push({ testGenerationId: runId, scenarioId });
        }

        await this.dispatch(snapshotId, architecture, testPlans);

        this.logger.info("Runs started for edit session", { snapshotId, count: testPlans.length });
        return { runIds: testPlans.map((plan) => plan.testGenerationId) };
    }

    async finalize(snapshotId: string, organizationId: string) {
        this.logger.info("Finalizing edit session", { snapshotId });

        const snapshot = await this.editSession(snapshotId, organizationId);
        // Unconditional on what did or did not run: an edit the user chose not to validate is still the suite
        // they authored, and refusing to promote it would discard the whole session.
        const promoted = await snapshot.promote();
        if (!promoted) throw new EditSessionSupersededError();

        this.logger.info("Edit session finalized", { snapshotId });
    }

    async discard(snapshotId: string, organizationId: string) {
        this.logger.info("Discarding edit session", { snapshotId });

        const snapshot = await this.editSession(snapshotId, organizationId);
        const cancelled = await snapshot.cancel("Discarded by the user");
        if (!cancelled) throw new EditSessionSupersededError();

        this.logger.info("Edit session discarded", { snapshotId });
    }

    private async openEditSnapshot(branchId: string, organizationId: string): Promise<OpenSnapshot> {
        try {
            return await this.suite.openEditSnapshot({ branchId, organizationId });
        } catch (error) {
            if (error instanceof BranchNotFoundError) throw new NotFoundError("Branch not found");
            if (error instanceof BranchAlreadyOpenError) throw await this.pendingSlotTaken(branchId, organizationId);
            throw error;
        }
    }

    /**
     * Loads the snapshot the caller's session opened, refusing anything the editor does not own.
     *
     * Addressing by id rather than by branch is what makes a superseded session fail instead of silently adopting
     * the winner's snapshot: a superseded snapshot is no longer `processing`, so it cannot be read or written.
     */
    private async editSession(snapshotId: string, organizationId: string): Promise<OpenSnapshot> {
        const snapshot = await this.reopen(snapshotId, organizationId);

        if (snapshot.trigger !== EDIT_SNAPSHOT_TRIGGER) {
            this.logger.warn("Refusing an edit operation on an analysis snapshot", {
                snapshotId,
                extra: { trigger: snapshot.trigger },
            });
            throw new AnalysisInFlightError();
        }

        return snapshot;
    }

    private async reopen(snapshotId: string, organizationId: string): Promise<OpenSnapshot> {
        try {
            return await this.suite.reopen(snapshotId, { organizationId });
        } catch (error) {
            const gone = error instanceof SnapshotNotOpenError || error instanceof SnapshotNotFoundError;
            if (!gone) throw error;

            this.logger.warn("Edit session snapshot is no longer open", { snapshotId, extra: { error } });
            throw new EditSessionSupersededError();
        }
    }

    /** The architecture this branch's runs execute as, having refused a branch that cannot execute one at all. */
    private async runnableArchitecture(snapshot: OpenSnapshot): Promise<ApplicationArchitecture> {
        const branch = await this.db.branch.findUniqueOrThrow({
            where: { id: snapshot.branchId },
            select: {
                application: { select: { architecture: true } },
                deployment: {
                    select: {
                        webDeployment: { select: { url: true } },
                        mobileDeployment: { select: { deploymentId: true } },
                    },
                },
            },
        });

        const { architecture } = branch.application;
        assertBranchCanRun(architecture, {
            webDeployment: branch.deployment?.webDeployment ?? undefined,
            mobileDeployment: branch.deployment?.mobileDeployment ?? undefined,
        });
        return architecture;
    }

    /**
     * Hand the started runs to the worker fleet. They are marked `queued` before the dispatch, never after: the
     * workflow flips a run to `running` the moment it picks it up, and a status write on the way back would race
     * that flip and report a running test as queued forever.
     */
    private async dispatch(
        snapshotId: string,
        architecture: WorkflowArchitecture,
        testPlans: TestPlanItem[],
    ): Promise<void> {
        if (testPlans.length === 0) return;

        const runIds = testPlans.map((plan) => plan.testGenerationId);
        await this.db.testGeneration.updateMany({ where: { id: { in: runIds } }, data: { status: "queued" } });

        try {
            await this.startGenerationBatch({ snapshotId, testPlans, architecture });
        } catch (error) {
            this.logger.fatal("Failed to dispatch runs for edit session", error, { snapshotId, runIds });
            await this.db.testGeneration.updateMany({
                where: { id: { in: runIds } },
                data: { status: "failed", reasoning: DISPATCH_FAILURE_REASONING },
            });
            throw error;
        }
    }

    /** Names whoever holds the branch's pending slot, so the caller is told which of the two it lost to. */
    private async pendingSlotTaken(branchId: string, organizationId: string) {
        const state = await this.getState(branchId, organizationId);
        return state.state === "open" ? new EditSessionAlreadyOpenError() : new AnalysisInFlightError();
    }
}

/** Every requested test must be one this snapshot assigns with a plan, or there is nothing to resolve a run from. */
function assertTestsRunnable(suite: Suite, testCaseIds: string[]): void {
    const runnable = new Set(suite.testCases.filter((test) => test.plan != null).map((test) => test.id));
    const refused = testCaseIds.filter((testCaseId) => !runnable.has(testCaseId));
    if (refused.length > 0) throw new TestsNotRunnableError(refused);
}

/**
 * The tests the session changed but has not run yet - what "Generate all" offers, and the one place that set is
 * derived. A removed test has nothing to run; a test whose run failed is offered again.
 */
function testsAwaitingRun(changes: SuiteChange[], runs: SuiteRun[]): string[] {
    const ranSuccessfully = new Set(runs.filter((run) => run.status !== "failed").map((run) => run.testCaseId));
    return changes
        .filter((change) => change.type !== "removed")
        .map((change) => change.testCaseId)
        .filter((testCaseId) => !ranSuccessfully.has(testCaseId));
}
