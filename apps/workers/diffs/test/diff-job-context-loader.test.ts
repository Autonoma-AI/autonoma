import { expect } from "vitest";
import { DiffJobContextLoader } from "../src/review/diff-job-context-loader";
import { diffJobContextSuite } from "./harness";

diffJobContextSuite({
    name: "DiffJobContextLoader",
    cases: (test) => {
        test("gathers generation steps, conversation, and the snapshot diff anchor for a generation", async ({
            harness,
            seedResult,
        }) => {
            const { generationId } = await harness.seedGeneration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                baseSha: "genbase0",
                headSha: "genhead1",
                testName: "Signup flow",
                testPlanPrompt: "Sign up with a fresh email and land on the welcome screen.",
                reasoning: "Stopped after the form rejected the email.",
                videoUrl: "generation/x/video.webm",
                conversation: [
                    { role: "assistant", content: "I will fill the email field." },
                    { role: "user", content: "continue" },
                ],
                steps: [
                    {
                        order: 0,
                        interaction: "type",
                        params: { target: "email", text: "new@test.com" },
                        output: { success: true, result: "typed" },
                        screenshotBefore: "generation/x/step-0-before.jpeg",
                        screenshotAfter: "generation/x/step-0-after.jpeg",
                    },
                    {
                        order: 1,
                        interaction: "click",
                        params: { target: "submit" },
                        output: { success: false, error: "validation error shown" },
                    },
                ],
            });

            const context = await new DiffJobContextLoader(harness.db, harness.storage).loadGeneration(generationId);

            expect(context.generationId).toBe(generationId);
            expect(context.organizationId).toBe(seedResult.organizationId);
            expect(context.selfReportedStatus).toBe("failed");
            expect(context.testPlanPrompt).toBe("Sign up with a fresh email and land on the welcome screen.");
            expect(context.reasoning).toBe("Stopped after the form rejected the email.");
            expect(context.videoUrl).toBe("generation/x/video.webm");

            expect(context.steps.map((s) => s.order)).toEqual([0, 1]);
            expect(context.steps[0]?.interaction).toBe("type");
            expect(context.steps[0]?.params).toEqual({ target: "email", text: "new@test.com" });
            expect(context.steps[0]?.screenshotBeforeKey).toBe("generation/x/step-0-before.jpeg");
            expect(context.steps[1]?.output).toEqual({ success: false, error: "validation error shown" });

            expect(context.conversation).toEqual([
                { role: "assistant", content: "I will fill the email field." },
                { role: "user", content: "continue" },
            ]);

            expect(context.change).toEqual({ baseSha: "genbase0", headSha: "genhead1" });
        });

        test("sources generation steps from the StepAttempt timeline, surfacing failed attempts the replay list omits", async ({
            harness,
            seedResult,
        }) => {
            const { generationId } = await harness.seedGeneration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                testName: "Signup flow",
                steps: [
                    // A failed attempt: present in the attempt timeline, absent from
                    // the successful-only StepInput replay list.
                    {
                        order: 0,
                        interaction: "click",
                        params: { description: "the Submit button" },
                        status: "failed",
                        error: "could not find element matching 'the Submit button'",
                        errorName: "ElementNotFoundError",
                        screenshotBefore: "generation/x/attempt-0-before.jpeg",
                    },
                    // A later successful attempt against the renamed control.
                    {
                        order: 1,
                        interaction: "click",
                        params: { description: "the Confirm button" },
                        status: "success",
                        output: { outcome: "success", point: { x: 10, y: 20 } },
                        screenshotBefore: "generation/x/step-0-before.jpeg",
                        screenshotAfter: "generation/x/step-0-after.jpeg",
                    },
                ],
            });

            const context = await new DiffJobContextLoader(harness.db, harness.storage).loadGeneration(generationId);

            // The full timeline comes back in order, failure included.
            expect(context.steps.map((s) => s.order)).toEqual([0, 1]);

            const failed = context.steps[0];
            expect(failed?.status).toBe("failed");
            expect(failed?.error).toBe("could not find element matching 'the Submit button'");
            expect(failed?.errorName).toBe("ElementNotFoundError");
            // A failed attempt carries no structured output.
            expect(failed?.output).toBeUndefined();
            expect(failed?.screenshotBeforeKey).toBe("generation/x/attempt-0-before.jpeg");

            const succeeded = context.steps[1];
            expect(succeeded?.status).toBe("success");
            expect(succeeded?.output).toEqual({ outcome: "success", point: { x: 10, y: 20 } });
            // A success carries no error fields.
            expect(succeeded?.error).toBeUndefined();
            expect(succeeded?.errorName).toBeUndefined();
        });

        test("returns an empty conversation for a generation with no conversation URL", async ({
            harness,
            seedResult,
        }) => {
            const { generationId } = await harness.seedGeneration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                steps: [{ order: 0, interaction: "click", params: {}, output: { success: false } }],
            });

            const context = await new DiffJobContextLoader(harness.db, harness.storage).loadGeneration(generationId);

            expect(context.conversation).toEqual([]);
            // No SHAs were seeded, so the change context is omitted entirely.
            expect(context.change).toBeUndefined();
        });

        test("materializes the generation's scenario generated-data graph into the context", async ({
            harness,
            seedResult,
        }) => {
            const { generationId } = await harness.seedGeneration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                baseSha: "genbase7",
                headSha: "genhead8",
                steps: [{ order: 0, interaction: "click", params: { target: "project" }, output: { success: false } }],
                scenario: {
                    name: "Generation org with one user and project",
                    generatedData: {
                        User: [{ _alias: "owner", email: "owner@example.test", name: "Pat Owner" }],
                        Project: [{ _alias: "proj", name: "Apollo", ownerId: { _ref: "owner" } }],
                    },
                },
            });

            const context = await new DiffJobContextLoader(harness.db, harness.storage).loadGeneration(generationId);

            expect(context.scenario?.scenarioName).toBe("Generation org with one user and project");
            expect(context.scenario?.entities).toEqual({
                User: [{ _alias: "owner", email: "owner@example.test", name: "Pat Owner" }],
                Project: [{ _alias: "proj", name: "Apollo", ownerId: { _ref: "owner" } }],
            });
        });

        test("omits scenario context for a generation when UP failed and no data was generated", async ({
            harness,
            seedResult,
        }) => {
            const { generationId } = await harness.seedGeneration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                steps: [{ order: 0, interaction: "click", params: {}, output: { success: false } }],
                scenario: { name: "Generation failed scenario", status: "UP_FAILED" },
            });

            const context = await new DiffJobContextLoader(harness.db, harness.storage).loadGeneration(generationId);

            expect(context.scenario).toBeUndefined();
        });

        test("omits scenario context when the generation has no scenario instance", async ({ harness, seedResult }) => {
            const { generationId } = await harness.seedGeneration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                steps: [{ order: 0, interaction: "click", params: {}, output: { success: false } }],
            });

            const context = await new DiffJobContextLoader(harness.db, harness.storage).loadGeneration(generationId);

            expect(context.scenario).toBeUndefined();
        });

    },
});
