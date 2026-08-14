import { AnalysisStore } from "@autonoma/analysis";
import { ApplicationArchitecture, type PrismaClient, createClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { type OpenSnapshot, TestSuiteStore } from "@autonoma/test-suite";
import { CANCELLED_RUN_REASON } from "@autonoma/types";
import { isApplicationUnlinkedFailure } from "@autonoma/workflow";
import { expect } from "vitest";
import { settleAnalysisRunState } from "../../src/activities/analysis/settle-analysis-run-state";
import { loadSnapshotMeta } from "../../src/codebase/snapshot-context";

let seq = 0;
const next = () => seq++;

interface SeededRun {
    organizationId: string;
    applicationId: string;
    branchId: string;
    snapshot: OpenSnapshot;
    testCaseId: string;
}

class SettleHarness implements IntegrationHarness {
    public readonly store: TestSuiteStore;

    constructor(public readonly db: PrismaClient) {
        this.store = new TestSuiteStore(db);
    }

    static async create(): Promise<SettleHarness> {
        const connectionUri = await createTestDatabase();
        return new SettleHarness(createClient(connectionUri));
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    /** An open analysis run: a pending snapshot with one authored test, and its running AnalysisJob. */
    async seedRun(): Promise<SeededRun> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const app = await this.db.application.create({
            data: {
                name: `App ${n}`,
                slug: `app-${n}`,
                organizationId: org.id,
                architecture: ApplicationArchitecture.WEB,
                // A linked repo, as a real in-flight run has - so a test can null it to stage a mid-run unlink.
                githubRepositoryId: 1_000 + n,
            },
        });
        const folder = await this.db.folder.create({
            data: { name: `Flow ${n}`, applicationId: app.id, organizationId: org.id },
        });
        const branch = await this.db.branch.create({
            data: { name: `feature/${n}`, applicationId: app.id, organizationId: org.id },
        });

        const snapshot = await this.store.openSnapshot({
            branchId: branch.id,
            headSha: `head-${n}`,
            source: { noPriorSnapshot: { baseSha: `base-${n}` } },
            trigger: "WEBHOOK",
        });
        await this.db.analysisJob.create({
            data: { snapshotId: snapshot.snapshotId, organizationId: org.id, status: "running", startedAt: new Date() },
        });
        const added = await snapshot.addTest({
            folderId: folder.id,
            name: `Checkout ${n}`,
            description: "Completes checkout",
            plan: "Open checkout",
        });

        return {
            organizationId: org.id,
            applicationId: app.id,
            branchId: branch.id,
            snapshot,
            testCaseId: added.testCaseId,
        };
    }
}

integrationTestSuite({
    name: "settleAnalysisRunState",
    createHarness: () => SettleHarness.create(),
    cases: (test) => {
        test("fails a run: releases the branch, marks the interrupted runs, reports what was discarded", async ({
            harness,
        }) => {
            const { branchId, snapshot, testCaseId } = await harness.seedRun();
            const { runId } = await snapshot.startRun(testCaseId);
            // A finding's classification hangs off the run; settlement must mark runs, never delete them.
            const finding = await harness.db.analysisFinding.create({
                data: {
                    reportSnapshotId: snapshot.snapshotId,
                    organizationId: snapshot.organizationId,
                    testCaseId,
                },
            });
            const classification = await harness.db.analysisClassification.create({
                data: {
                    findingId: finding.id,
                    number: 1,
                    organizationId: snapshot.organizationId,
                    generationId: runId,
                    category: "engine_artifact",
                    headline: "The run stopped while settling.",
                },
            });
            await harness.db.analysisFinding.update({
                where: { id: finding.id },
                data: { currentClassificationId: classification.id },
            });

            const result = await settleAnalysisRunState({
                db: harness.db,
                snapshotId: snapshot.snapshotId,
                outcome: { kind: "failed", reason: "Reporter crashed" },
            });

            // The one authored test is the change the failure discarded.
            expect(result).toEqual({ settled: true, snapshotStatus: "failed", discardedChangeCount: 1 });
            const [settledSnapshot, branch, job, run] = await Promise.all([
                harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: snapshot.snapshotId } }),
                harness.db.branch.findUniqueOrThrow({ where: { id: branchId } }),
                harness.db.analysisJob.findUniqueOrThrow({ where: { snapshotId: snapshot.snapshotId } }),
                harness.db.testGeneration.findUniqueOrThrow({ where: { id: runId } }),
            ]);
            expect(settledSnapshot.status).toBe("failed");
            expect(branch.pendingSnapshotId).toBeNull();
            expect(job.status).toBe("failed");
            expect(job.failureReason).toContain("Reporter crashed");
            expect(job.failureReason).toContain("1 suite changes discarded");
            expect(run).toMatchObject({
                status: "failed",
                failure: { kind: "engine_error", message: "Reporter crashed" },
            });
            // The classification survives on the marked run.
            expect(await harness.db.analysisClassification.count({ where: { generationId: runId } })).toBe(1);
        });

        test("promotes a successful run unconditionally and completes its AnalysisJob", async ({ harness }) => {
            const { branchId, snapshot, testCaseId } = await harness.seedRun();
            // A run nobody ever executed does not veto promotion.
            const { runId } = await snapshot.startRun(testCaseId);

            const result = await settleAnalysisRunState({
                db: harness.db,
                snapshotId: snapshot.snapshotId,
                outcome: { kind: "succeeded" },
            });

            expect(result).toEqual({ settled: true, snapshotStatus: "active", discardedChangeCount: 0 });
            const [settledSnapshot, branch, job, run] = await Promise.all([
                harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: snapshot.snapshotId } }),
                harness.db.branch.findUniqueOrThrow({ where: { id: branchId } }),
                harness.db.analysisJob.findUniqueOrThrow({ where: { snapshotId: snapshot.snapshotId } }),
                harness.db.testGeneration.findUniqueOrThrow({ where: { id: runId } }),
            ]);
            expect(settledSnapshot.status).toBe("active");
            expect(branch.activeSnapshotId).toBe(snapshot.snapshotId);
            expect(branch.pendingSnapshotId).toBeNull();
            expect(job.status).toBe("completed");
            expect(job.completedAt).not.toBeNull();
            expect(run.status).toBe("pending");
        });

        test("the second settlement is a no-op that reports it lost", async ({ harness }) => {
            const { snapshot } = await harness.seedRun();

            const first = await settleAnalysisRunState({
                db: harness.db,
                snapshotId: snapshot.snapshotId,
                outcome: { kind: "succeeded" },
            });
            const second = await settleAnalysisRunState({
                db: harness.db,
                snapshotId: snapshot.snapshotId,
                outcome: { kind: "failed", reason: "late failure" },
            });

            expect(first.settled).toBe(true);
            expect(second).toEqual({ settled: false, discardedChangeCount: 0 });
            const settledSnapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: snapshot.snapshotId },
            });
            expect(settledSnapshot.status).toBe("active");
            const job = await harness.db.analysisJob.findUniqueOrThrow({ where: { snapshotId: snapshot.snapshotId } });
            expect(job.status).toBe("completed");
        });

        test("a run whose application is unlinked mid-flight settles cancelled and is not a genuine failure", async ({
            harness,
        }) => {
            const { organizationId, applicationId, snapshot } = await harness.seedRun();

            // The application is deleted / unlinked / org-disconnected while this run is in flight - all null the
            // repo id under it. The run's next codebase load discovers it.
            await harness.db.application.update({
                where: { id: applicationId },
                data: { githubRepositoryId: null },
            });

            // Containment: loadSnapshotMeta throws the typed failure the settlement wrapper maps to `cancelled`.
            const error = await loadSnapshotMeta(snapshot.snapshotId, harness.db).then(
                () => undefined,
                (caught: unknown) => caught,
            );
            expect(error).toBeInstanceOf(Error);
            expect(isApplicationUnlinkedFailure(error)).toBe(true);

            const result = await settleAnalysisRunState({
                db: harness.db,
                snapshotId: snapshot.snapshotId,
                outcome: { kind: "cancelled", reason: CANCELLED_RUN_REASON },
            });

            expect(result).toEqual({ settled: true, snapshotStatus: "cancelled", discardedChangeCount: 1 });
            const settledSnapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: snapshot.snapshotId },
            });
            expect(settledSnapshot.status).toBe("cancelled");
            const job = await harness.db.analysisJob.findUniqueOrThrow({ where: { snapshotId: snapshot.snapshotId } });
            // Status stays `failed` (it did not complete), but `cancelled` is the machine-readable discriminator and
            // the reason keeps its plain prose - no "suite changes discarded" suffix a genuine failure would add.
            expect(job.status).toBe("failed");
            expect(job.cancelled).toBe(true);
            expect(job.superseded).toBe(false);
            expect(job.failureReason).toBe(CANCELLED_RUN_REASON);

            // Excluded from genuine-failure counts, consistent with a superseded run.
            const facts = new AnalysisStore(harness.db).forApplication(applicationId, organizationId);
            const counts = await facts.jobCounts({ since: new Date(0) });
            expect(counts).toEqual({ total: 1, genuineFailures: 0 });
        });

        test("a superseded run settles cancelled with the reason on its job", async ({ harness }) => {
            const { snapshot } = await harness.seedRun();

            const result = await settleAnalysisRunState({
                db: harness.db,
                snapshotId: snapshot.snapshotId,
                outcome: { kind: "superseded", reason: "Superseded by a newer analysis request" },
            });

            expect(result).toEqual({ settled: true, snapshotStatus: "cancelled", discardedChangeCount: 1 });
            const settledSnapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: snapshot.snapshotId },
            });
            expect(settledSnapshot.status).toBe("cancelled");
            const job = await harness.db.analysisJob.findUniqueOrThrow({ where: { snapshotId: snapshot.snapshotId } });
            expect(job.status).toBe("failed");
            expect(job.failureReason).toContain("Superseded");
        });
    },
});
