import { type SnapshotRunContext, buildVerdicts } from "@autonoma/diffs";
import { logger } from "@autonoma/logger";
import { expect } from "vitest";
import { DiffJobContextLoader } from "../src/review/diff-job-context-loader";
import { diffJobContextSuite } from "./harness";

/** Index a snapshot's gathered runs by test name for order-insensitive assertions. */
function byTestName(runs: SnapshotRunContext[]): Map<string, SnapshotRunContext> {
    return new Map(runs.map((run) => [run.testName, run]));
}

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

        test("gathers snapshot-scope change facts plus every flagged run, with per-run scenario data", async ({
            harness,
            seedResult,
        }) => {
            const { snapshotId } = await harness.seedResolutionSnapshot({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                baseSha: "snapbase",
                headSha: "snaphead",
                analysisReasoning: "Renamed the checkout button and added a coupon field.",
                runs: [
                    {
                        testName: "Checkout flow",
                        affectedReason: "code_change",
                        affectedReasoning: "Clicks the renamed checkout button.",
                        planPrompt: "Buy an item and reach the confirmation page.",
                        review: {
                            verdict: "engine_error",
                            reasoning: "The button id changed; the step is stale.",
                        },
                        scenario: {
                            name: "Cart with one item",
                            generatedData: {
                                User: [{ _alias: "shopper", email: "shopper@test.com" }],
                                CartItem: [{ _alias: "item", name: "Widget", ownerId: { _ref: "shopper" } }],
                            },
                        },
                    },
                    {
                        testName: "Coupon flow",
                        affectedReason: "code_change",
                        affectedReasoning: "Exercises the new coupon field.",
                        review: {
                            verdict: "application_bug",
                            reasoning: "Coupon never applied.",
                            issue: { title: "Coupon not applied", description: "Total unchanged after coupon." },
                        },
                    },
                ],
            });

            const context = await new DiffJobContextLoader(harness.db).loadSnapshot(snapshotId);

            expect(context.snapshotId).toBe(snapshotId);
            expect(context.organizationId).toBe(seedResult.organizationId);
            expect(context.change).toEqual({ baseSha: "snapbase", headSha: "snaphead" });
            expect(context.analysisReasoning).toBe("Renamed the checkout button and added a coupon field.");
            expect(context.runs).toHaveLength(2);

            const runs = byTestName(context.runs);
            const checkout = runs.get("Checkout flow");
            expect(checkout?.runStatus).toBe("failed");
            expect(checkout?.quarantined).toBe(false);
            expect(checkout?.affectedReason).toBe("code_change");
            expect(checkout?.affectedReasoning).toBe("Clicks the renamed checkout button.");
            expect(checkout?.testPlanPrompt).toBe("Buy an item and reach the confirmation page.");
            expect(checkout?.review).toEqual({
                verdict: "engine_error",
                reasoning: "The button id changed; the step is stale.",
            });
            expect(checkout?.scenario?.scenarioName).toBe("Cart with one item");
            expect(checkout?.scenario?.entities.CartItem).toEqual([
                { _alias: "item", name: "Widget", ownerId: { _ref: "shopper" } },
            ]);

            const coupon = runs.get("Coupon flow");
            expect(coupon?.review).toEqual({
                verdict: "application_bug",
                reasoning: "Coupon never applied.",
                issueTitle: "Coupon not applied",
                issueDescription: "Total unchanged after coupon.",
            });
            // No scenario was attached to this run.
            expect(coupon?.scenario).toBeUndefined();
            // Resolution runs before any refinement loop, so lineage is empty.
            expect(coupon?.lineage).toBeUndefined();
        });

        test("gathers all replayed runs regardless of outcome; buildVerdicts filters to the actionable ones", async ({
            harness,
            seedResult,
        }) => {
            const { snapshotId } = await harness.seedResolutionSnapshot({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                baseSha: "b",
                headSha: "h",
                runs: [
                    {
                        testName: "Actionable",
                        affectedReason: "code_change",
                        affectedReasoning: "stale step",
                        review: { verdict: "engine_error", reasoning: "needs a rewrite" },
                    },
                    {
                        testName: "Passed",
                        affectedReason: "code_change",
                        affectedReasoning: "still works",
                        runStatus: "success",
                        review: { verdict: "engine_error", reasoning: "n/a" },
                    },
                    {
                        testName: "Quarantined",
                        affectedReason: "code_change",
                        affectedReasoning: "owned by manual review",
                        quarantined: true,
                        review: { verdict: "application_bug", reasoning: "known bug" },
                    },
                    {
                        testName: "NoCompletedReview",
                        affectedReason: "code_change",
                        affectedReasoning: "review still running",
                        review: { status: "pending" },
                    },
                ],
            });

            const context = await new DiffJobContextLoader(harness.db).loadSnapshot(snapshotId);

            // The loader gathers every flagged run - it does not pre-filter.
            expect(context.runs).toHaveLength(4);
            const runs = byTestName(context.runs);
            expect(runs.get("Passed")?.runStatus).toBe("success");
            expect(runs.get("Quarantined")?.quarantined).toBe(true);
            // A non-completed review contributes no verdict to the gathered context.
            expect(runs.get("NoCompletedReview")?.review).toBeUndefined();

            // Resolution's actionability filter keeps only the one actionable run.
            const verdicts = buildVerdicts(context.runs, logger.child({ name: "buildVerdicts-test" }));
            expect(verdicts.map((v) => v.testName)).toEqual(["Actionable"]);
            expect(verdicts[0]?.verdict).toBe("engine_error");
        });

        test("reads the quarantine gate from the baseline snapshot when one is supplied", async ({
            harness,
            seedResult,
        }) => {
            const { snapshotId } = await harness.seedResolutionSnapshot({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                baseSha: "b",
                headSha: "h",
                runs: [
                    {
                        testName: "Quarantined in current snapshot",
                        affectedReason: "code_change",
                        affectedReasoning: "reportBug quarantined it",
                        quarantined: true,
                        review: { verdict: "application_bug", reasoning: "real bug" },
                    },
                ],
            });

            // A different (baseline) snapshot has no quarantining assignment for
            // this test, so the gate reads false there - recovering the
            // pre-resolution view the same way capture's "previous" baseline does.
            const otherBaseline = await harness.createSnapshot(seedResult.organizationId, seedResult.applicationId);
            const context = await new DiffJobContextLoader(harness.db).loadSnapshot(snapshotId, {
                baselineSnapshotId: otherBaseline,
            });

            expect(context.runs[0]?.quarantined).toBe(false);
        });

        test("omits snapshot change context when the snapshot has no SHAs", async ({ harness, seedResult }) => {
            const { snapshotId } = await harness.seedResolutionSnapshot({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                analysisReasoning: "Reasoning present, but no SHAs to diff against.",
                runs: [
                    {
                        testName: "Some test",
                        affectedReason: "code_change",
                        affectedReasoning: "flagged",
                        review: { verdict: "engine_error", reasoning: "stale" },
                    },
                ],
            });

            const context = await new DiffJobContextLoader(harness.db).loadSnapshot(snapshotId);

            expect(context.change).toBeUndefined();
            // Analysis reasoning is decoupled from the SHA-gated diff anchor, so it
            // survives even when there are no SHAs to `git diff` against.
            expect(context.analysisReasoning).toBe("Reasoning present, but no SHAs to diff against.");
            // Runs are still gathered even without a diffable change context.
            expect(context.runs).toHaveLength(1);
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
