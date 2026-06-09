import { resolveScenarioRecipesForSnapshot } from "@autonoma/diffs";
import { expect } from "vitest";
import { replayContextSuite } from "./harness";

replayContextSuite({
    name: "resolveScenarioRecipesForSnapshot",
    cases: (test) => {
        test("materializes the point-in-time recipe template for the requested scenarios", async ({
            harness,
            seedResult,
        }) => {
            const snapshotId = await harness.createSnapshot(seedResult.organizationId, seedResult.applicationId);

            const adminScenarioId = await harness.seedScenarioRecipeVersion({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                snapshotId,
                scenarioName: "authenticated-admin",
                description: "Logged-in admin with one workspace",
                create: {
                    User: [{ _alias: "admin", email: "admin+{{testRunId}}@example.com", role: "admin" }],
                    Workspace: [{ _alias: "ws", name: "Acme", ownerId: { _ref: "admin" } }],
                },
            });

            const recipes = await resolveScenarioRecipesForSnapshot(harness.db, snapshotId, [adminScenarioId]);

            expect(recipes).toEqual([
                {
                    scenarioId: adminScenarioId,
                    scenarioName: "authenticated-admin",
                    description: "Logged-in admin with one workspace",
                    entities: {
                        User: [{ _alias: "admin", email: "admin+{{testRunId}}@example.com", role: "admin" }],
                        Workspace: [{ _alias: "ws", name: "Acme", ownerId: { _ref: "admin" } }],
                    },
                },
            ]);
        });

        test("resolves multiple scenarios in a stable name-sorted order", async ({ harness, seedResult }) => {
            const snapshotId = await harness.createSnapshot(seedResult.organizationId, seedResult.applicationId);

            const betaId = await harness.seedScenarioRecipeVersion({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                snapshotId,
                scenarioName: "beta",
                create: { User: [{ _alias: "b" }] },
            });
            const alphaId = await harness.seedScenarioRecipeVersion({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                snapshotId,
                scenarioName: "alpha",
                create: { User: [{ _alias: "a" }] },
            });

            const recipes = await resolveScenarioRecipesForSnapshot(harness.db, snapshotId, [betaId, alphaId]);

            expect(recipes.map((r) => r.scenarioName)).toEqual(["alpha", "beta"]);
        });

        test("returns an empty array when no scenario ids are requested", async ({ harness, seedResult }) => {
            const snapshotId = await harness.createSnapshot(seedResult.organizationId, seedResult.applicationId);

            const recipes = await resolveScenarioRecipesForSnapshot(harness.db, snapshotId, []);

            expect(recipes).toEqual([]);
        });

        test("omits a scenario that has no recipe version for the snapshot", async ({ harness, seedResult }) => {
            const snapshotId = await harness.createSnapshot(seedResult.organizationId, seedResult.applicationId);
            const otherSnapshotId = await harness.createSnapshot(seedResult.organizationId, seedResult.applicationId);

            // Recipe version exists only for `otherSnapshotId`, not the one queried.
            const scenarioId = await harness.seedScenarioRecipeVersion({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                snapshotId: otherSnapshotId,
                scenarioName: "elsewhere",
                create: { User: [{ _alias: "u" }] },
            });

            const recipes = await resolveScenarioRecipesForSnapshot(harness.db, snapshotId, [scenarioId]);

            expect(recipes).toEqual([]);
        });

        test("omits a scenario whose recipe declares no usable create entities", async ({ harness, seedResult }) => {
            const snapshotId = await harness.createSnapshot(seedResult.organizationId, seedResult.applicationId);

            const scenarioId = await harness.seedScenarioRecipeVersion({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                snapshotId,
                scenarioName: "empty-recipe",
                create: {},
            });

            const recipes = await resolveScenarioRecipesForSnapshot(harness.db, snapshotId, [scenarioId]);

            expect(recipes).toEqual([]);
        });
    },
});
