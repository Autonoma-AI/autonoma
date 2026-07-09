import type { HealingFailureSubject } from "@autonoma/diffs";
import { expect } from "vitest";
import { DiffJobContextLoader } from "../src/review/diff-job-context-loader";
import { type SeededHealingSubject, diffJobContextSuite } from "./harness";

/** Project a seeded healing subject into the lean descriptor `loadHealingContext` consumes. */
function toHealingSubject(seeded: SeededHealingSubject): HealingFailureSubject {
    return {
        failureKey: seeded.failureKey,
        sourceId: seeded.sourceId,
        planId: seeded.planId,
        testCaseId: seeded.testCaseId,
    };
}

diffJobContextSuite({
    name: "DiffJobContextLoader",
    cases: (test) => {
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
            expect(context.lineage).toEqual([]);
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

        test("falls back to the StepInput replay list for a generation predating the StepAttempt timeline", async ({
            harness,
            seedResult,
        }) => {
            // A pre-StepAttempt generation: only StepInput/StepOutput rows exist,
            // no attempts. The loader must still surface its steps via the fallback.
            const { generationId } = await harness.seedGeneration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                legacyStepInputs: [
                    {
                        order: 0,
                        interaction: "type",
                        params: { description: "email", text: "new@test.com" },
                        output: { outcome: "success" },
                        screenshotBefore: "generation/x/step-0-before.jpeg",
                        screenshotAfter: "generation/x/step-0-after.jpeg",
                    },
                    {
                        order: 1,
                        interaction: "click",
                        params: { description: "submit" },
                        output: { outcome: "success", point: { x: 5, y: 9 } },
                    },
                ],
            });

            const context = await new DiffJobContextLoader(harness.db, harness.storage).loadGeneration(generationId);

            expect(context.steps.map((s) => s.order)).toEqual([0, 1]);
            // Every fallback step is a success - that era only persisted successes.
            expect(context.steps.every((s) => s.status === "success")).toBe(true);
            expect(context.steps[0]?.params).toEqual({ description: "email", text: "new@test.com" });
            expect(context.steps[0]?.screenshotBeforeKey).toBe("generation/x/step-0-before.jpeg");
            expect(context.steps[1]?.output).toEqual({ outcome: "success", point: { x: 5, y: 9 } });
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
                        verdict: { verdict: "unknown_issue", reasoning: "Submit button selector looked stale." },
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

            expect(context.lineage).toEqual([
                {
                    iterationNumber: 1,
                    prompt: "Click the old Submit button",
                    verdicts: [{ verdict: "unknown_issue", reasoning: "Submit button selector looked stale." }],
                },
                {
                    iterationNumber: 2,
                    prompt: "Click the renamed Confirm button",
                    healingReasoning: "Renamed Submit to Confirm in the diff, so I rewrote the step.",
                    verdicts: [],
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

            expect(context.lineage).toEqual([]);
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

        test("gathers healing-scope change facts plus per-failure lineage, scenario, and affected facts", async ({
            harness,
            seedResult,
        }) => {
            const seeded = await harness.seedHealingIteration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                baseSha: "healbase",
                headSha: "healhead",
                analysisReasoning: "Renamed the Submit button to Confirm and reworked signup validation.",
                subjects: [
                    {
                        testName: "Checkout flow",
                        affected: { reason: "code_change", reasoning: "Clicks the renamed Submit button." },
                        scenario: {
                            name: "Healing cart with one item",
                            generatedData: {
                                User: [{ _alias: "shopper", email: "shopper@test.com" }],
                                CartItem: [{ _alias: "item", name: "Widget", ownerId: { _ref: "shopper" } }],
                            },
                        },
                        iterations: [
                            {
                                number: 1,
                                planPrompt: "Click the old Submit button",
                                verdict: { verdict: "unknown_issue", reasoning: "Submit selector was stale." },
                            },
                            {
                                number: 2,
                                planPrompt: "Click the renamed Confirm button",
                                healingReasoning: "Renamed Submit to Confirm, rewrote the step.",
                                subject: true,
                            },
                        ],
                    },
                    {
                        testName: "Signup flow",
                        affected: { reason: "code_change", reasoning: "Fills out the signup form." },
                        iterations: [{ number: 1, planPrompt: "Sign up with a fresh email", subject: true }],
                    },
                ],
            });

            const context = await new DiffJobContextLoader(harness.db).loadHealingContext({
                snapshotId: seeded.snapshotId,
                subjects: seeded.subjects.map(toHealingSubject),
            });

            expect(context.snapshotId).toBe(seeded.snapshotId);
            expect(context.organizationId).toBe(seedResult.organizationId);
            expect(context.applicationId).toBe(seedResult.applicationId);
            expect(context.change).toEqual({ baseSha: "healbase", headSha: "healhead" });
            expect(context.analysisReasoning).toBe(
                "Renamed the Submit button to Confirm and reworked signup validation.",
            );
            expect(context.subjects).toHaveLength(2);

            const byKey = new Map(context.subjects.map((subject) => [subject.failureKey, subject]));
            const [checkoutSeed, signupSeed] = seeded.subjects;

            // Failure at iteration 2: full lineage, scenario, and affected facts.
            const checkout = byKey.get(checkoutSeed?.failureKey ?? "");
            expect(checkout?.affectedReason).toBe("code_change");
            expect(checkout?.affectedReasoning).toBe("Clicks the renamed Submit button.");
            expect(checkout?.lineage).toEqual([
                {
                    iterationNumber: 1,
                    prompt: "Click the old Submit button",
                    verdicts: [{ verdict: "unknown_issue", reasoning: "Submit selector was stale." }],
                },
                {
                    iterationNumber: 2,
                    prompt: "Click the renamed Confirm button",
                    healingReasoning: "Renamed Submit to Confirm, rewrote the step.",
                    verdicts: [],
                },
            ]);
            expect(checkout?.scenario?.scenarioName).toBe("Healing cart with one item");
            expect(checkout?.scenario?.entities.CartItem).toEqual([
                { _alias: "item", name: "Widget", ownerId: { _ref: "shopper" } },
            ]);

            // First-iteration generation failure: flagged, but no lineage and no scenario.
            const signup = byKey.get(signupSeed?.failureKey ?? "");
            expect(signup?.affectedReason).toBe("code_change");
            expect(signup?.affectedReasoning).toBe("Fills out the signup form.");
            expect(signup?.lineage).toEqual([]);
            expect(signup?.scenario).toBeUndefined();
        });

        test("omits healing change context for a SHA-less snapshot but keeps analysis reasoning", async ({
            harness,
            seedResult,
        }) => {
            const seeded = await harness.seedHealingIteration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                analysisReasoning: "Reasoning present, but no SHAs to diff against.",
                subjects: [
                    {
                        testName: "Some test",
                        affected: { reason: "code_change", reasoning: "flagged" },
                        iterations: [{ number: 1, planPrompt: "do the thing", subject: true }],
                    },
                ],
            });

            const context = await new DiffJobContextLoader(harness.db).loadHealingContext({
                snapshotId: seeded.snapshotId,
                subjects: seeded.subjects.map(toHealingSubject),
            });

            expect(context.change).toBeUndefined();
            // Analysis reasoning is decoupled from the SHA-gated diff anchor.
            expect(context.analysisReasoning).toBe("Reasoning present, but no SHAs to diff against.");
            expect(context.subjects).toHaveLength(1);
            expect(context.subjects[0]?.affectedReason).toBe("code_change");
        });
    },
});
