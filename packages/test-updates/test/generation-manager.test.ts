import { expect } from "vitest";
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
