import { expect } from "vitest";
import { AddTest } from "../src/changes/add-test";
import { FakeGenerationProvider } from "../src/generation/fake-generation-provider";
import { testUpdateSuite } from "./harness";

testUpdateSuite({
    name: "TestSuiteUpdater",
    cases: (test) => {
        test("apply: adds a test case and schedules generation", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            const updater = await harness.startUpdater(organizationId, applicationId, { jobProvider });

            await updater.apply(
                new AddTest({
                    name: "Apply test",
                    description: "Tests apply",
                    plan: "Some plan",
                }),
            );

            await updater.queuePendingGenerations();

            expect(jobProvider.firedBatches).toHaveLength(1);
            expect(jobProvider.firedBatches[0]).toHaveLength(1);
        });

        test("assignGenerationResults: assigns steps from successful generations", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            const updater = await harness.startUpdater(organizationId, applicationId, { jobProvider });

            await updater.apply(
                new AddTest({
                    name: "Assign test",
                    description: "Tests assignment",
                    plan: "Some plan",
                }),
            );

            await updater.queuePendingGenerations();
            // biome-ignore lint/style/noNonNullAssertion: just created
            const { testGenerationId: generationId, planId } = jobProvider.firedBatches[0]![0]!;

            // Simulate a successful generation run
            const stepInputList = await harness.db.stepInputList.create({
                data: { planId, organizationId },
            });
            await harness.db.testGeneration.update({
                where: { id: generationId },
                data: { status: "success", stepsId: stepInputList.id },
            });

            const { assigned, failed } = await updater.assignGenerationResults([generationId]);

            expect(assigned).toBe(1);
            expect(failed).toBe(0);
        });

        test("assignGenerationResults: skips failed generations", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            const updater = await harness.startUpdater(organizationId, applicationId, { jobProvider });

            await updater.apply(
                new AddTest({
                    name: "Fail test",
                    description: "Tests failure",
                    plan: "Some plan",
                }),
            );

            await updater.queuePendingGenerations();
            // biome-ignore lint/style/noNonNullAssertion: just created
            const { testGenerationId: generationId } = jobProvider.firedBatches[0]![0]!;

            await harness.db.testGeneration.update({
                where: { id: generationId },
                data: { status: "failed" },
            });

            const { assigned, failed } = await updater.assignGenerationResults([generationId]);

            expect(assigned).toBe(0);
            expect(failed).toBe(1);
        });

        test("assignGenerationResults: handles mixed success and failure", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            const updater = await harness.startUpdater(organizationId, applicationId, { jobProvider });

            await updater.apply(
                new AddTest({
                    name: "Success test",
                    description: "Will succeed",
                    plan: "Plan A",
                }),
            );
            await updater.apply(
                new AddTest({
                    name: "Failure test",
                    description: "Will fail",
                    plan: "Plan B",
                }),
            );

            await updater.queuePendingGenerations();
            // biome-ignore lint/style/noNonNullAssertion: just created
            const [genSuccess, genFailure] = jobProvider.firedBatches[0]!;

            // Simulate: first succeeds, second fails
            const stepInputList = await harness.db.stepInputList.create({
                // biome-ignore lint/style/noNonNullAssertion: just created
                data: { planId: genSuccess!.planId, organizationId },
            });
            await harness.db.testGeneration.update({
                // biome-ignore lint/style/noNonNullAssertion: just created
                where: { id: genSuccess!.testGenerationId },
                data: { status: "success", stepsId: stepInputList.id },
            });
            await harness.db.testGeneration.update({
                // biome-ignore lint/style/noNonNullAssertion: just created
                where: { id: genFailure!.testGenerationId },
                data: { status: "failed" },
            });

            const { assigned, failed } = await updater.assignGenerationResults([
                // biome-ignore lint/style/noNonNullAssertion: just created
                genSuccess!.testGenerationId,
                // biome-ignore lint/style/noNonNullAssertion: just created
                genFailure!.testGenerationId,
            ]);

            expect(assigned).toBe(1);
            expect(failed).toBe(1);
        });

        // -- finalize() --

        test("finalize: activates the snapshot when all generations are complete", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            const updater = await harness.startUpdater(organizationId, applicationId, {
                jobProvider,
            });

            await updater.apply(
                new AddTest({
                    name: "Finalize test",
                    description: "Tests finalize",
                    plan: "Some plan",
                }),
            );

            await updater.queuePendingGenerations();
            // biome-ignore lint/style/noNonNullAssertion: just created
            const { testGenerationId: generationId } = jobProvider.firedBatches[0]![0]!;

            await harness.db.testGeneration.update({
                where: { id: generationId },
                data: { status: "success" },
            });

            await updater.finalize();
        });

        test("finalize: throws when there are incomplete generations", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            const updater = await harness.startUpdater(organizationId, applicationId, {
                jobProvider,
            });

            await updater.apply(
                new AddTest({
                    name: "Incomplete test",
                    description: "Tests incomplete check",
                    plan: "Some plan",
                }),
            );

            // Generation is still pending - finalize should throw
            await expect(updater.finalize()).rejects.toThrow("Cannot finalize snapshot");
        });

        // -- queuePendingGenerations() --

        test("queuePendingGenerations: fires jobs and marks generations as queued", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            const updater = await harness.startUpdater(organizationId, applicationId, { jobProvider });

            await updater.apply(
                new AddTest({
                    name: "Queue test A",
                    description: "First test to queue",
                    plan: "Plan A",
                }),
            );
            await updater.apply(
                new AddTest({
                    name: "Queue test B",
                    description: "Second test to queue",
                    plan: "Plan B",
                }),
            );

            await updater.queuePendingGenerations();

            // Verify a single batch was fired with both generations
            expect(jobProvider.firedBatches).toHaveLength(1);
            // biome-ignore lint/style/noNonNullAssertion: asserted above
            const batch = jobProvider.firedBatches[0]!;
            expect(batch).toHaveLength(2);
        });

        test("queuePendingGenerations: no-op when no pending generations exist", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            const updater = await harness.startUpdater(organizationId, applicationId, { jobProvider });

            await updater.queuePendingGenerations();

            expect(jobProvider.firedBatches).toHaveLength(0);
        });

        // -- getChanges() --

        test("getChanges: reflects applied AddTest changes", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            const updater = await harness.startUpdater(organizationId, applicationId, { jobProvider });

            await updater.apply(
                new AddTest({
                    name: "New test",
                    description: "Tests getChanges",
                    plan: "New plan",
                }),
            );

            const changes = await updater.getChanges();
            expect(changes).toHaveLength(1);

            const added = changes.find((c) => c.type === "added");
            expect(added?.testCaseName).toBe("New test");
        });

        // -- discard() --

        test("discard: cleans up snapshot and allows new edit session", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            const updater = await harness.startUpdater(organizationId, applicationId, { jobProvider });
            const snapshotId = updater.snapshotId;

            await updater.discard();

            // Branch should have no pending snapshot
            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: updater.branchId },
                select: { pendingSnapshotId: true },
            });
            expect(branch.pendingSnapshotId).toBeNull();

            // Snapshot should be deleted
            const snapshot = await harness.db.branchSnapshot.findUnique({ where: { id: snapshotId } });
            expect(snapshot).toBeNull();

            // Should be able to start a new session
            const newUpdater = await harness.startUpdater(organizationId, applicationId, { jobProvider });
            expect(newUpdater.snapshotId).toBeDefined();
        });
    },
});
