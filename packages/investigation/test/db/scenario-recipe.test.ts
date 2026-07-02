import { expect } from "vitest";
import { ScenarioRecipe } from "../../src";
import { investigationDbSuite } from "../harness";

investigationDbSuite({
    name: "ScenarioRecipe",
    cases: (test) => {
        test("returns the recipe's create graph as JSON for a scenario on a snapshot", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const { snapshotId } = await harness.setupTestCase(organizationId, application.id, "recipe-read");
            const applicationId = application.id;

            const scenario = await harness.db.scenario.create({
                data: { applicationId, organizationId, name: "standard" },
            });
            const schemaSnapshot = await harness.db.scenarioSchemaSnapshot.create({
                data: { applicationId, snapshotId, structureJson: { models: {} }, fingerprint: "fp-schema" },
            });
            const createGraph = { User: [{ _alias: "u1", email: "a@example.test" }], Project: [{ name: "P1" }] };
            await harness.db.scenarioRecipeVersion.create({
                data: {
                    scenarioId: scenario.id,
                    snapshotId,
                    schemaSnapshotId: schemaSnapshot.id,
                    applicationId,
                    organizationId,
                    scenarioNameSnapshot: "standard",
                    fingerprint: "fp-recipe",
                    validationStatus: "validated",
                    validationMethod: "up_down",
                    validationPhase: "full",
                    fixtureJson: {
                        name: "standard",
                        description: "the standard scenario",
                        create: createGraph,
                        validation: { status: "validated", method: "endpoint-up-down", phase: "ok" },
                    },
                },
            });

            const recipe = new ScenarioRecipe(harness.db);
            const graph = await recipe.getCreateGraph(scenario.id, snapshotId);

            expect(graph).toBeDefined();
            expect(JSON.parse(graph ?? "null")).toEqual(createGraph);
        });

        test("returns undefined when no recipe version exists for the scenario/snapshot pair", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const { snapshotId } = await harness.setupTestCase(organizationId, application.id, "recipe-missing");
            const recipe = new ScenarioRecipe(harness.db);

            expect(await recipe.getCreateGraph("does-not-exist", snapshotId)).toBeUndefined();
        });
    },
});
