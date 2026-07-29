import { expect } from "vitest";
import { settleAnalysisRunState } from "../src/queries/settle-analysis-run-state";
import { testUpdateSuite } from "./harness";

testUpdateSuite({
    name: "settleAnalysisRunState",
    cases: (test) => {
        test("fails a run atomically enough to release the branch and preserve generation history", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            const manager = harness.generationManagerFor(draft);
            const checkout = await draft.addTestCase({
                folderId,
                name: "Checkout",
                description: "Completes checkout",
                plan: "Open checkout",
            });
            const cart = await draft.addTestCase({
                folderId,
                name: "Cart",
                description: "Updates cart",
                plan: "Open cart",
            });
            const profile = await draft.addTestCase({
                folderId,
                name: "Profile",
                description: "Updates profile",
                plan: "Open profile",
            });
            const checkoutGenerationId = await manager.addJob(checkout.planId);
            const cartGenerationId = await manager.addJob(cart.planId);
            const profileGenerationId = await manager.addJob(profile.planId);
            const generationIds = [checkoutGenerationId, cartGenerationId, profileGenerationId];
            await harness.db.testGeneration.update({ where: { id: cartGenerationId }, data: { status: "queued" } });
            await harness.db.testGeneration.update({ where: { id: profileGenerationId }, data: { status: "running" } });
            await harness.db.analysisJob.create({
                data: { snapshotId: draft.snapshotId, organizationId, status: "running", startedAt: new Date() },
            });
            // Anchored to a generation the sweep touches: the finding's classification cascades away if
            // settlement ever deletes generations instead of failing them.
            const finding = await harness.db.analysisFinding.create({
                data: { reportSnapshotId: draft.snapshotId, organizationId, testCaseId: checkout.testCaseId },
            });
            const classification = await harness.db.analysisClassification.create({
                data: {
                    findingId: finding.id,
                    number: 1,
                    organizationId,
                    generationId: checkoutGenerationId,
                    category: "engine_artifact",
                    headline: "The generation stopped while settling.",
                },
            });
            await harness.db.analysisFinding.update({
                where: { id: finding.id },
                data: { currentClassificationId: classification.id },
            });

            const result = await settleAnalysisRunState({
                db: harness.db,
                snapshotId: draft.snapshotId,
                outcome: { kind: "failed", reason: "Reporter crashed" },
            });

            expect(result).toMatchObject({ settled: true, snapshotStatus: "failed", generationsFailed: 3 });
            const [snapshot, branch, job, settledGenerations, findingCount] = await Promise.all([
                harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: draft.snapshotId } }),
                harness.db.branch.findUniqueOrThrow({ where: { id: draft.branchId } }),
                harness.db.analysisJob.findUniqueOrThrow({ where: { snapshotId: draft.snapshotId } }),
                harness.db.testGeneration.findMany({ where: { id: { in: generationIds } }, orderBy: { id: "asc" } }),
                harness.db.analysisFinding.count({ where: { reportSnapshotId: draft.snapshotId } }),
            ]);
            expect(snapshot.status).toBe("failed");
            expect(branch.pendingSnapshotId).toBeNull();
            expect(job).toMatchObject({ status: "failed", failureReason: expect.stringContaining("Reporter crashed") });
            expect(settledGenerations).toHaveLength(3);
            for (const generation of settledGenerations) {
                expect(generation).toMatchObject({
                    status: "failed",
                    failure: { kind: "engine_error", message: "Reporter crashed" },
                });
            }
            expect(findingCount).toBe(1);
        });

        test("makes the second settlement a no-op and tolerates a legacy snapshot without an AnalysisJob", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);

            const first = await settleAnalysisRunState({
                db: harness.db,
                snapshotId: draft.snapshotId,
                outcome: { kind: "superseded", reason: "Newer push" },
            });
            const second = await settleAnalysisRunState({
                db: harness.db,
                snapshotId: draft.snapshotId,
                outcome: { kind: "failed", reason: "Must not overwrite" },
            });

            expect(first).toMatchObject({ settled: true, snapshotStatus: "cancelled" });
            expect(second).toMatchObject({ settled: false });
            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: draft.snapshotId } });
            expect(snapshot.status).toBe("cancelled");
        });

        test("promotes a successful run and completes its AnalysisJob", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            await harness.db.analysisJob.create({
                data: { snapshotId: draft.snapshotId, organizationId, status: "running", startedAt: new Date() },
            });

            const result = await settleAnalysisRunState({
                db: harness.db,
                snapshotId: draft.snapshotId,
                outcome: { kind: "succeeded" },
            });

            expect(result).toMatchObject({ settled: true, snapshotStatus: "active" });
            const job = await harness.db.analysisJob.findUniqueOrThrow({ where: { snapshotId: draft.snapshotId } });
            expect(job.status).toBe("completed");
        });

        test("promotes a run whose generations never ran, keeping each one and its verdict", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            const manager = harness.generationManagerFor(draft);
            const testCase = await draft.addTestCase({
                folderId,
                name: "Companies list",
                description: "Loads the companies list",
                plan: "Open companies",
            });
            // Never leaves `pending`: this is what an Investigator whose scenario setup failed leaves behind.
            const generationId = await manager.addJob(testCase.planId);
            await harness.db.analysisJob.create({
                data: { snapshotId: draft.snapshotId, organizationId, status: "running", startedAt: new Date() },
            });
            const finding = await harness.db.analysisFinding.create({
                data: { reportSnapshotId: draft.snapshotId, organizationId, testCaseId: testCase.testCaseId },
            });
            const classification = await harness.db.analysisClassification.create({
                data: {
                    findingId: finding.id,
                    number: 1,
                    organizationId,
                    generationId,
                    category: "engine_artifact",
                    headline: "Scenario setup failed before the app was exercised.",
                },
            });
            await harness.db.analysisFinding.update({
                where: { id: finding.id },
                data: { currentClassificationId: classification.id },
            });

            const result = await settleAnalysisRunState({
                db: harness.db,
                snapshotId: draft.snapshotId,
                outcome: { kind: "succeeded" },
            });

            expect(result).toMatchObject({ settled: true, snapshotStatus: "active", generationsFailed: 1 });
            const [generation, settledFinding] = await Promise.all([
                harness.db.testGeneration.findUnique({ where: { id: generationId } }),
                harness.db.analysisFinding.findUniqueOrThrow({ where: { id: finding.id } }),
            ]);
            expect(generation).toMatchObject({ status: "failed", failure: { kind: "engine_error" } });
            // The whole point: promoting the snapshot must not cascade the verdict away.
            expect(settledFinding.currentClassificationId).toBe(classification.id);
        });

        test("downgrades a blocked promotion to failure and settles every state", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            const manager = harness.generationManagerFor(draft);
            const testCase = await draft.addTestCase({
                folderId,
                name: "Queued checkout",
                description: "Cannot finish in time",
                plan: "Open checkout",
            });
            const generationId = await manager.addJob(testCase.planId);
            await harness.db.testGeneration.update({ where: { id: generationId }, data: { status: "running" } });
            await harness.db.analysisJob.create({
                data: { snapshotId: draft.snapshotId, organizationId, status: "running", startedAt: new Date() },
            });

            const result = await settleAnalysisRunState({
                db: harness.db,
                snapshotId: draft.snapshotId,
                outcome: { kind: "succeeded" },
            });

            expect(result).toMatchObject({
                settled: true,
                snapshotStatus: "failed",
                outcome: { kind: "failed", reason: expect.stringContaining("incomplete generations") },
            });
            const [snapshot, job, generation] = await Promise.all([
                harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: draft.snapshotId } }),
                harness.db.analysisJob.findUniqueOrThrow({ where: { snapshotId: draft.snapshotId } }),
                harness.db.testGeneration.findUniqueOrThrow({ where: { id: generationId } }),
            ]);
            expect(snapshot.status).toBe("failed");
            expect(job.status).toBe("failed");
            expect(generation.status).toBe("failed");
        });
    },
});
