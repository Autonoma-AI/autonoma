import { materializeScenarioData } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { expect } from "vitest";
import { recoverScenarioDataForRun } from "../evals/capture/recover-scenario-data";
import { recoverScenarioDataForGeneration } from "../evals/capture/recover-scenario-data-for-generation";
import { diffJobContextSuite } from "./harness";

const logger = rootLogger.child({ name: "recover-scenario-data.test" });

/**
 * The resolved create graph a scenario seeds - the shape `markUpSuccess` writes
 * to `generatedData` and `SdkClient.up` records under `request_body.create`.
 */
const CREATE_GRAPH = {
    User: [{ _alias: "owner", email: "owner@example.test", name: "Pat Owner" }],
    Project: [{ _alias: "proj", name: "Apollo", ownerId: { _ref: "owner" } }],
};

diffJobContextSuite({
    name: "recoverScenarioData (eval-only webhook fallback)",
    cases: (test) => {
        test("recovers a run's scenario data from the UP webhook when generatedData is null", async ({
            harness,
            seedResult,
        }) => {
            const { runId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                steps: [{ order: 0, interaction: "click", params: { target: "project" }, output: { outcome: "fail" } }],
                // Pre-#822 legacy instance: it came up, but generatedData was never
                // persisted - only the UP webhook carries the create graph.
                scenario: { name: "Org with one user and project", upWebhookCreate: CREATE_GRAPH },
            });

            const recovered = await recoverScenarioDataForRun(harness.db, runId);

            // Recovery must equal what a populated generatedData would have yielded.
            expect(recovered).toEqual(materializeScenarioData("Org with one user and project", CREATE_GRAPH, logger));
            expect(recovered?.scenarioName).toBe("Org with one user and project");
            expect(Object.keys(recovered?.entities ?? {})).toEqual(expect.arrayContaining(["User", "Project"]));
        });

        test("recovers a generation's scenario data from the UP webhook when generatedData is null", async ({
            harness,
            seedResult,
        }) => {
            const { generationId } = await harness.seedGeneration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                scenario: { name: "Seeded org", upWebhookCreate: CREATE_GRAPH },
            });

            const recovered = await recoverScenarioDataForGeneration(harness.db, generationId);

            expect(recovered).toEqual(materializeScenarioData("Seeded org", CREATE_GRAPH, logger));
        });

        test("returns undefined when the scenario never came up (UP_FAILED), even with a logged request", async ({
            harness,
            seedResult,
        }) => {
            const { runId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                scenario: { name: "Failed to provision", status: "UP_FAILED", upWebhookCreate: CREATE_GRAPH },
            });

            expect(await recoverScenarioDataForRun(harness.db, runId)).toBeUndefined();
        });

        test("returns undefined when the instance came up but no UP webhook survives", async ({
            harness,
            seedResult,
        }) => {
            const { runId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                // UP_SUCCESS instance, but neither generatedData nor a webhook row.
                scenario: { name: "No log survives" },
            });

            expect(await recoverScenarioDataForRun(harness.db, runId)).toBeUndefined();
        });

        test("returns undefined when the run has no scenario instance at all", async ({ harness, seedResult }) => {
            const { runId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
            });

            expect(await recoverScenarioDataForRun(harness.db, runId)).toBeUndefined();
        });
    },
});
