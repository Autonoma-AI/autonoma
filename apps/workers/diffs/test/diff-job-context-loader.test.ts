import { expect } from "vitest";
import { DiffJobContextLoader } from "../src/review/replay/diff-job-context-loader";
import { replayContextSuite } from "./harness";

replayContextSuite({
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
    },
});
