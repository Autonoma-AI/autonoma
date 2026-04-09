import { expect } from "vitest";
import { FakeGenerationProvider } from "../src/generation/fake-generation-provider";
import { MissingJobProviderError } from "../src/generation/generation-manager";
import { testUpdateSuite } from "./harness";

testUpdateSuite({
    name: "GenerationManager",
    cases: (test) => {
        test("addJob: creates a pending generation record", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            const manager = draft.generationManager();

            const { planId } = await draft.addTestCase({
                name: "Gen test",
                description: "Tests generation",
                plan: "Some plan",
            });

            await manager.addJob(planId);

            const pending = await manager.getPendingGenerations();
            expect(pending).toHaveLength(1);
            expect(pending[0]?.planId).toBe(planId);
        });

        test("addJob: replaces existing pending generation for same test case", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            const manager = draft.generationManager();

            const { testCaseId, planId: firstPlanId } = await draft.addTestCase({
                name: "Replace test",
                description: "Tests replacement",
                plan: "First plan",
            });

            await manager.addJob(firstPlanId);

            const { planId: secondPlanId } = await draft.updatePlan({
                testCaseId,
                plan: "Second plan",
            });

            await manager.addJob(secondPlanId);

            const pending = await manager.getPendingGenerations();
            expect(pending).toHaveLength(1);
            expect(pending[0]?.planId).toBe(secondPlanId);
        });

        test("addJob: handles multiple test cases independently", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            const manager = draft.generationManager();

            const { planId: planA } = await draft.addTestCase({
                name: "Test A",
                description: "First test",
                plan: "Plan A",
            });

            const { planId: planB } = await draft.addTestCase({
                name: "Test B",
                description: "Second test",
                plan: "Plan B",
            });

            await manager.addJob(planA);
            await manager.addJob(planB);

            const pending = await manager.getPendingGenerations();
            expect(pending).toHaveLength(2);

            const planIds = pending.map((p) => p.planId);
            expect(planIds).toContain(planA);
            expect(planIds).toContain(planB);
        });

        test("getPendingGenerations: returns empty array when no generations exist", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            const manager = draft.generationManager();

            const pending = await manager.getPendingGenerations();
            expect(pending).toHaveLength(0);
        });

        // -- getGenerationSummary() --

        test("getGenerationSummary: returns empty array when no generations exist", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            const manager = draft.generationManager();

            const summary = await manager.getGenerationSummary();
            expect(summary).toHaveLength(0);
        });

        test("getGenerationSummary: returns generation status per test case", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            const manager = draft.generationManager();

            const { planId: planA } = await draft.addTestCase({
                name: "Summary A",
                description: "First",
                plan: "Plan A",
            });

            const { planId: planB } = await draft.addTestCase({
                name: "Summary B",
                description: "Second",
                plan: "Plan B",
            });

            await manager.addJob(planA);
            await manager.addJob(planB);

            const summary = await manager.getGenerationSummary();
            expect(summary).toHaveLength(2);
            expect(summary.every((s) => s.status === "pending")).toBe(true);
        });

        test("getGenerationSummary: returns latest generation per test case", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            const manager = draft.generationManager();

            const { testCaseId, planId: firstPlanId } = await draft.addTestCase({
                name: "Latest gen",
                description: "Tests latest",
                plan: "First plan",
            });

            await manager.addJob(firstPlanId);

            // Update plan creates a new generation, replacing the old pending one
            const { planId: secondPlanId } = await draft.updatePlan({
                testCaseId,
                plan: "Second plan",
            });

            await manager.addJob(secondPlanId);

            const summary = await manager.getGenerationSummary();
            expect(summary).toHaveLength(1);
            expect(summary[0]?.testCaseId).toBe(testCaseId);
        });

        // -- queuePendingGenerations() --

        test("queuePendingGenerations: throws when no job provider is configured", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            const manager = draft.generationManager();

            await expect(manager.queuePendingGenerations()).rejects.toThrow(MissingJobProviderError);
        });

        test("queuePendingGenerations: returns generationsQueued false when no pending generations", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            const { manager } = await harness.startDraftWithDeployment(organizationId, applicationId, { jobProvider });

            const result = await manager.queuePendingGenerations();

            expect(result.generationsQueued).toBe(false);
            expect(jobProvider.firedBatches).toHaveLength(0);
        });

        test("queuePendingGenerations: fires jobs and marks generations as queued", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            const { draft, manager } = await harness.startDraftWithDeployment(organizationId, applicationId, {
                jobProvider,
            });

            const { planId: planA } = await draft.addTestCase({
                name: "Queue A",
                description: "First",
                plan: "Plan A",
            });
            const { planId: planB } = await draft.addTestCase({
                name: "Queue B",
                description: "Second",
                plan: "Plan B",
            });

            await manager.addJob(planA);
            await manager.addJob(planB);

            const result = await manager.queuePendingGenerations();

            expect(result.generationsQueued).toBe(true);
            expect(jobProvider.firedBatches).toHaveLength(1);
            // biome-ignore lint/style/noNonNullAssertion: asserted above
            expect(jobProvider.firedBatches[0]!).toHaveLength(2);

            // Generations should no longer be pending
            const pending = await manager.getPendingGenerations();
            expect(pending).toHaveLength(0);
        });

        test("queuePendingGenerations: marks generations as failed when fireJobs throws", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            jobProvider.fireJobs = async () => {
                throw new Error("Job provider exploded");
            };
            const { draft, manager } = await harness.startDraftWithDeployment(organizationId, applicationId, {
                jobProvider,
            });

            const { planId } = await draft.addTestCase({
                name: "Exploding test",
                description: "Should fail on fire",
                plan: "Some plan",
            });

            await manager.addJob(planId);

            const result = await manager.queuePendingGenerations();

            expect(result.generationsQueued).toBe(false);

            const pending = await manager.getPendingGenerations();
            expect(pending).toHaveLength(0);

            const summary = await manager.getGenerationSummary();
            expect(summary).toHaveLength(1);
            expect(summary[0]?.status).toBe("failed");
        });

        test("queuePendingGenerations: marks generations as failed when no deployment is configured", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const jobProvider = new FakeGenerationProvider();
            // startDraft creates a branch without a deployment
            const draft = await harness.startDraft(organizationId, applicationId);
            const manager = draft.generationManager({ jobProvider });

            const { planId } = await draft.addTestCase({
                name: "No deploy test",
                description: "Should fail validation",
                plan: "Some plan",
            });

            await manager.addJob(planId);

            const result = await manager.queuePendingGenerations();

            expect(result.generationsQueued).toBe(false);
            expect(jobProvider.firedBatches).toHaveLength(0);

            // Generation should be marked as failed, not pending
            const pending = await manager.getPendingGenerations();
            expect(pending).toHaveLength(0);

            const summary = await manager.getGenerationSummary();
            expect(summary).toHaveLength(1);
            expect(summary[0]?.status).toBe("failed");
        });

        test("getGenerationSummary: picks the most recent generation when multiple coexist", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            const manager = draft.generationManager();

            const { testCaseId, planId } = await draft.addTestCase({
                name: "Multi gen",
                description: "Tests multiple generations",
                plan: "The plan",
            });

            await manager.addJob(planId);

            // Mark the first generation as failed so addJob won't delete it
            const firstResult = await manager.getPendingGenerations();
            // biome-ignore lint/style/noNonNullAssertion: we know there's at least one pending generation
            const firstGenId = firstResult[0]!.testGenerationId;
            await harness.db.testGeneration.update({
                where: { id: firstGenId },
                data: { status: "failed" },
            });

            // Add a new generation for the same plan - this one coexists with the failed one
            await manager.addJob(planId);
            const secondResult = await manager.getPendingGenerations();
            // biome-ignore lint/style/noNonNullAssertion: we know there's at least one pending generation
            const secondGenId = secondResult[0]!.testGenerationId;

            // Mark the second as success
            await harness.db.testGeneration.update({
                where: { id: secondGenId },
                data: { status: "success" },
            });

            const summary = await manager.getGenerationSummary();
            const entry = summary.find((s) => s.testCaseId === testCaseId);
            expect(entry).toBeDefined();
            // biome-ignore lint/style/noNonNullAssertion: This is checked above
            expect(entry!.generationId).toBe(secondGenId);
            // biome-ignore lint/style/noNonNullAssertion: This is checked above
            expect(entry!.status).toBe("success");
        });
    },
});
