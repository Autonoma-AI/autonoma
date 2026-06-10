import { expect } from "vitest";
import { DiffJobContextLoader } from "../src/review/diff-job-context-loader";
import { diffJobContextSuite } from "./harness";

diffJobContextSuite({
    name: "DiffJobContextLoader",
    cases: (test) => {
        test("gathers run steps plus the DB-sourced change context for a flagged run", async ({
            harness,
            seedResult,
        }) => {
            const { runId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                baseSha: "base000",
                headSha: "head111",
                analysisReasoning: "Login form markup was rewritten; the submit button id changed.",
                affected: { reason: "code_change", reasoning: "This test clicks the submit button that was renamed." },
                testName: "Login flow",
                testPlanPrompt: "Log in with valid credentials and land on the dashboard.",
                steps: [
                    {
                        order: 0,
                        interaction: "type",
                        params: { target: "email", text: "user@test.com" },
                        output: { outcome: "success" },
                        screenshotBefore: "run/x/step-0-before.jpeg",
                        screenshotAfter: "run/x/step-0-after.jpeg",
                    },
                    {
                        order: 1,
                        interaction: "click",
                        params: { target: "submit" },
                        output: { outcome: "element_not_found" },
                        screenshotBefore: "run/x/step-1-before.jpeg",
                    },
                ],
            });

            const context = await new DiffJobContextLoader(harness.db).load(runId);

            expect(context.runId).toBe(runId);
            expect(context.organizationId).toBe(seedResult.organizationId);
            expect(context.testPlanPrompt).toBe("Log in with valid credentials and land on the dashboard.");
            expect(context.testCaseName).toBe("Login flow");
            expect(context.videoS3Key).toBe(`run/${runId}/video.webm`);

            // Steps come back ordered, with interaction/params from the input and outcome from the output.
            expect(context.steps.map((s) => s.order)).toEqual([0, 1]);
            expect(context.steps[0]?.interaction).toBe("type");
            expect(context.steps[0]?.params).toEqual({ target: "email", text: "user@test.com" });
            expect(context.steps[1]?.output).toEqual({ outcome: "element_not_found" });
            // Final screenshot falls back to the last step's "before" when it has no "after".
            expect(context.finalScreenshotKey).toBe("run/x/step-1-before.jpeg");

            expect(context.change).toEqual({
                baseSha: "base000",
                headSha: "head111",
                analysisReasoning: "Login form markup was rewritten; the submit button id changed.",
                affectedReason: "code_change",
                affectedReasoning: "This test clicks the submit button that was renamed.",
            });
        });

        test("includes SHAs but omits affected fields when the run's test was not flagged", async ({
            harness,
            seedResult,
        }) => {
            const { runId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                baseSha: "base222",
                headSha: "head333",
                analysisReasoning: "Refactored the checkout service.",
                steps: [{ order: 0, interaction: "click", params: { target: "buy" }, output: { outcome: "success" } }],
            });

            const context = await new DiffJobContextLoader(harness.db).load(runId);

            expect(context.change?.baseSha).toBe("base222");
            expect(context.change?.headSha).toBe("head333");
            expect(context.change?.analysisReasoning).toBe("Refactored the checkout service.");
            expect(context.change?.affectedReason).toBeUndefined();
            expect(context.change?.affectedReasoning).toBeUndefined();
        });

        test("omits the change context entirely when the snapshot has no SHAs", async ({ harness, seedResult }) => {
            const { runId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                affected: { reason: "merge_conflict", reasoning: "ignored - no SHAs to diff against" },
                steps: [{ order: 0, interaction: "click", params: {}, output: { outcome: "success" } }],
            });

            const context = await new DiffJobContextLoader(harness.db).load(runId);

            expect(context.change).toBeUndefined();
        });

        test("materializes the run's scenario generated-data graph into the context", async ({
            harness,
            seedResult,
        }) => {
            const { runId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                baseSha: "base777",
                headSha: "head888",
                steps: [{ order: 0, interaction: "click", params: { target: "project" }, output: { outcome: "fail" } }],
                scenario: {
                    name: "Org with one user and project",
                    generatedData: {
                        User: [{ _alias: "owner", email: "owner@example.test", name: "Pat Owner" }],
                        Project: [{ _alias: "proj", name: "Apollo", ownerId: { _ref: "owner" } }],
                    },
                },
            });

            const context = await new DiffJobContextLoader(harness.db).load(runId);

            expect(context.scenario?.scenarioName).toBe("Org with one user and project");
            expect(context.scenario?.entities).toEqual({
                User: [{ _alias: "owner", email: "owner@example.test", name: "Pat Owner" }],
                Project: [{ _alias: "proj", name: "Apollo", ownerId: { _ref: "owner" } }],
            });
        });

        test("omits scenario context when UP failed and no data was generated", async ({ harness, seedResult }) => {
            const { runId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                steps: [{ order: 0, interaction: "click", params: {}, output: { outcome: "fail" } }],
                scenario: { name: "Failed scenario", status: "UP_FAILED" },
            });

            const context = await new DiffJobContextLoader(harness.db).load(runId);

            expect(context.scenario).toBeUndefined();
        });

        test("omits scenario context when the run has no scenario instance", async ({ harness, seedResult }) => {
            const { runId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                steps: [{ order: 0, interaction: "click", params: {}, output: { outcome: "fail" } }],
            });

            const context = await new DiffJobContextLoader(harness.db).load(runId);

            expect(context.scenario).toBeUndefined();
        });

        test("carries no lineage for a run outside any refinement loop", async ({ harness, seedResult }) => {
            const { runId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                steps: [{ order: 0, interaction: "click", params: {}, output: { outcome: "fail" } }],
            });

            const context = await new DiffJobContextLoader(harness.db).load(runId);

            expect(context.lineage).toBeUndefined();
        });

        test("carries no lineage for a first-iteration run inside a refinement loop", async ({
            harness,
            seedResult,
        }) => {
            const { subjectRunId } = await harness.seedRefinementLineage({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                iterations: [{ number: 1, planPrompt: "Seed plan", subject: true }],
                steps: [{ order: 0, interaction: "click", params: {}, output: { outcome: "fail" } }],
            });

            const context = await new DiffJobContextLoader(harness.db).load(subjectRunId);

            expect(context.lineage).toBeUndefined();
        });

        test("gathers point-in-time prior verdicts and plan history for an iteration-2 run", async ({
            harness,
            seedResult,
        }) => {
            const { subjectRunId } = await harness.seedRefinementLineage({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                iterations: [
                    {
                        number: 1,
                        planPrompt: "Click the old Submit button",
                        verdict: { verdict: "engine_error", reasoning: "Submit button selector looked stale." },
                    },
                    {
                        number: 2,
                        planPrompt: "Click the renamed Confirm button",
                        healingReasoning: "Renamed Submit to Confirm in the diff, so I rewrote the step.",
                        subject: true,
                    },
                ],
                steps: [{ order: 0, interaction: "click", params: { target: "confirm" }, output: { outcome: "fail" } }],
            });

            const context = await new DiffJobContextLoader(harness.db).load(subjectRunId);

            expect(context.lineage).toBeDefined();
            expect(context.lineage?.priorVerdicts).toEqual([
                { iterationNumber: 1, verdict: "engine_error", reasoning: "Submit button selector looked stale." },
            ]);
            expect(context.lineage?.planHistory).toEqual([
                { iterationNumber: 1, prompt: "Click the old Submit button" },
                {
                    iterationNumber: 2,
                    prompt: "Click the renamed Confirm button",
                    healingReasoning: "Renamed Submit to Confirm in the diff, so I rewrote the step.",
                },
            ]);
        });

        test("excludes later iterations and uncompleted reviews from a mid-loop run's lineage (point-in-time)", async ({
            harness,
            seedResult,
        }) => {
            // Three iterations exist in the DB, but the subject ran in iteration 2.
            // Its lineage must see iteration 1 only - iteration 3 did not exist when
            // the subject executed.
            const { subjectRunId } = await harness.seedRefinementLineage({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                iterations: [
                    {
                        number: 1,
                        planPrompt: "v1",
                        verdict: { verdict: "engine_error", reasoning: "iter1 verdict" },
                    },
                    {
                        number: 2,
                        planPrompt: "v2",
                        healingReasoning: "rewrite for v2",
                        verdict: { verdict: "application_bug", reasoning: "iter2 verdict (later)" },
                        subject: true,
                    },
                    {
                        number: 3,
                        planPrompt: "v3",
                        healingReasoning: "rewrite for v3",
                    },
                ],
                steps: [{ order: 0, interaction: "click", params: {}, output: { outcome: "fail" } }],
            });

            const context = await new DiffJobContextLoader(harness.db).load(subjectRunId);

            // History stops at the subject's own iteration (2); iteration 3 is excluded.
            expect(context.lineage?.planHistory.map((p) => p.iterationNumber)).toEqual([1, 2]);
            // Only the earlier iteration's verdict; the subject's own iteration-2
            // verdict is the review-in-progress and must not appear.
            expect(context.lineage?.priorVerdicts).toEqual([
                { iterationNumber: 1, verdict: "engine_error", reasoning: "iter1 verdict" },
            ]);
        });

        test("reads the run's own plan prompt, not the assignment's later-repointed plan (point-in-time)", async ({
            harness,
            seedResult,
        }) => {
            const { runId, assignmentId, testCaseId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                baseSha: "base444",
                headSha: "head555",
                testPlanPrompt: "Prompt as executed by the run",
                steps: [{ order: 0, interaction: "click", params: {}, output: { outcome: "fail" } }],
            });

            // Simulate a healing updatePlan: the assignment now points at a new plan.
            await harness.repointAssignmentPlan(
                assignmentId,
                testCaseId,
                seedResult.organizationId,
                "Healed prompt the run never saw",
            );

            const context = await new DiffJobContextLoader(harness.db).load(runId);

            expect(context.testPlanPrompt).toBe("Prompt as executed by the run");
        });

        test("gathers generation steps, conversation, and the DB-sourced change context for a flagged generation", async ({
            harness,
            seedResult,
        }) => {
            const { generationId } = await harness.seedGeneration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                baseSha: "genbase0",
                headSha: "genhead1",
                analysisReasoning: "Signup form validation was rewritten.",
                affected: { reason: "code_change", reasoning: "This test fills out the signup form." },
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

            expect(context.change).toEqual({
                baseSha: "genbase0",
                headSha: "genhead1",
                analysisReasoning: "Signup form validation was rewritten.",
                affectedReason: "code_change",
                affectedReasoning: "This test fills out the signup form.",
            });
            // First-iteration generation outside any loop carries no lineage.
            expect(context.lineage).toBeUndefined();
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

        test("gathers point-in-time prior verdicts and plan history for an iteration-2 generation", async ({
            harness,
            seedResult,
        }) => {
            const { subjectGenerationId } = await harness.seedGenerationRefinementLineage({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                iterations: [
                    {
                        number: 1,
                        planPrompt: "Click the old Submit button",
                        verdict: { verdict: "engine_error", reasoning: "Submit button selector looked stale." },
                    },
                    {
                        number: 2,
                        planPrompt: "Click the renamed Confirm button",
                        healingReasoning: "Renamed Submit to Confirm in the diff, so I rewrote the step.",
                        subject: true,
                    },
                ],
                steps: [{ order: 0, interaction: "click", params: { target: "confirm" }, output: { success: false } }],
            });

            const context = await new DiffJobContextLoader(harness.db, harness.storage).loadGeneration(
                subjectGenerationId,
            );

            expect(context.lineage).toBeDefined();
            expect(context.lineage?.priorVerdicts).toEqual([
                { iterationNumber: 1, verdict: "engine_error", reasoning: "Submit button selector looked stale." },
            ]);
            expect(context.lineage?.planHistory).toEqual([
                { iterationNumber: 1, prompt: "Click the old Submit button" },
                {
                    iterationNumber: 2,
                    prompt: "Click the renamed Confirm button",
                    healingReasoning: "Renamed Submit to Confirm in the diff, so I rewrote the step.",
                },
            ]);
        });

        test("carries no lineage for a first-iteration generation inside a refinement loop", async ({
            harness,
            seedResult,
        }) => {
            const { subjectGenerationId } = await harness.seedGenerationRefinementLineage({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                iterations: [{ number: 1, planPrompt: "Seed plan", subject: true }],
                steps: [{ order: 0, interaction: "click", params: {}, output: { success: false } }],
            });

            const context = await new DiffJobContextLoader(harness.db, harness.storage).loadGeneration(
                subjectGenerationId,
            );

            expect(context.lineage).toBeUndefined();
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
