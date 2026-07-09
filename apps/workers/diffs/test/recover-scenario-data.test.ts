import { materializeScenarioData } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { expect } from "vitest";
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
            const { generationId } = await harness.seedGeneration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                scenario: { name: "Failed to provision", status: "UP_FAILED", upWebhookCreate: CREATE_GRAPH },
            });

            expect(await recoverScenarioDataForGeneration(harness.db, generationId)).toBeUndefined();
        });

        test("returns undefined when the instance came up but no UP webhook survives", async ({
            harness,
            seedResult,
        }) => {
            const { generationId } = await harness.seedGeneration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                // UP_SUCCESS instance, but neither generatedData nor a webhook row.
                scenario: { name: "No log survives" },
            });

            expect(await recoverScenarioDataForGeneration(harness.db, generationId)).toBeUndefined();
        });

        test("returns undefined when the generation has no scenario instance at all", async ({
            harness,
            seedResult,
        }) => {
            const { generationId } = await harness.seedGeneration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
            });

            expect(await recoverScenarioDataForGeneration(harness.db, generationId)).toBeUndefined();
        });
    },
});
