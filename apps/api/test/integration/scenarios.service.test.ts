import { ApplicationArchitecture } from "@autonoma/db";
import { ScenarioRecipeStore } from "@autonoma/scenario";
import type { ScenarioRecipe } from "@autonoma/types";
import { TRPCError } from "@trpc/server";
import { expect } from "vitest";
import { ApplicationSetupService } from "../../src/application-setup/application-setup.service";
import { RecipeConflictError } from "../../src/routes/scenarios/recipe-conflict-error";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

function makeRecipe(overrides: Partial<ScenarioRecipe> = {}): ScenarioRecipe {
    return {
        name: "standard",
        description: "standard",
        create: { User: [{ _alias: "user1", name: "Alice" }] },
        validation: { status: "validated", method: "checkScenario", phase: "ok" },
        ...overrides,
    };
}

async function createFixture(harness: APITestHarness, name: string) {
    const app = await harness.services.applications.createApplication({
        name,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });

    const service = new ApplicationSetupService(
        harness.db,
        harness.generationProvider,
        harness.services.onboarding,
        new ScenarioRecipeStore(harness.db),
    );
    const { id: setupId } = await service.createSetup(harness.userId, harness.organizationId, app.id, app.name);

    await service.uploadScenarioRecipeVersions(setupId, harness.organizationId, {
        version: 1,
        source: { discoverPath: "autonoma/discover.json", scenariosPath: "autonoma/scenarios.md" },
        validationMode: "sdk-check",
        recipes: [makeRecipe()],
    });

    const scenario = await harness.db.scenario.findFirstOrThrow({
        where: { applicationId: app.id, name: "standard" },
        select: { id: true, activeRecipeVersionId: true },
    });

    if (app.mainBranchId == null) throw new Error("Application has no main branch");
    return { app, service: harness.services.scenarios, scenario, branchId: app.mainBranchId };
}

apiTestSuite({
    name: "scenarios-service",
    cases: (test) => {
        test("updateRecipe updates the active recipe and scenario metadata", async ({ harness }) => {
            const { service, scenario, app } = await createFixture(harness, "Scenario Recipe Active Update");
            const nextRecipe = makeRecipe({
                description: "updated active",
                create: { User: [{ _alias: "user1", name: "Bob" }] },
            });

            const result = await service.updateRecipe({
                applicationId: app.id,
                organizationId: harness.organizationId,
                scenarioId: scenario.id,
                fixtureJson: JSON.stringify(nextRecipe),
                source: "UI",
            });

            expect(result.updatedRecipeVersions).toEqual([
                { id: scenario.activeRecipeVersionId, snapshotId: expect.any(String), target: "active" },
            ]);

            const updatedScenario = await harness.db.scenario.findUniqueOrThrow({
                where: { id: scenario.id },
                select: {
                    description: true,
                    lastSeenFingerprint: true,
                    fingerprintChangedAt: true,
                    activeRecipeVersion: { select: { fixtureJson: true, fingerprint: true } },
                },
            });
            expect(updatedScenario.description).toBe("updated active");
            expect(updatedScenario.fingerprintChangedAt).toBeTruthy();
            expect(updatedScenario.activeRecipeVersion?.fixtureJson).toEqual(nextRecipe);
            expect(updatedScenario.activeRecipeVersion?.fingerprint).toBe(updatedScenario.lastSeenFingerprint);
        });

        test("updateRecipe updates active and pending main snapshot recipe rows", async ({ harness }) => {
            const { service, scenario, branchId, app } = await createFixture(harness, "Scenario Recipe Pending Update");
            const { snapshotId: pendingSnapshotId } = await harness.request().snapshotEdit.start({ branchId });
            const pendingBefore = await harness.db.scenarioRecipeVersion.findUniqueOrThrow({
                where: { scenarioId_snapshotId: { scenarioId: scenario.id, snapshotId: pendingSnapshotId } },
                select: { id: true },
            });
            const nextRecipe = makeRecipe({
                description: "updated pending",
                create: { User: [{ _alias: "user1", name: "Pending Bob" }] },
            });

            const result = await service.updateRecipe({
                applicationId: app.id,
                organizationId: harness.organizationId,
                scenarioId: scenario.id,
                fixtureJson: JSON.stringify(nextRecipe),
                source: "UI",
            });

            expect(result.updatedRecipeVersions).toEqual([
                { id: scenario.activeRecipeVersionId, snapshotId: expect.any(String), target: "active" },
                { id: pendingBefore.id, snapshotId: pendingSnapshotId, target: "main-pending" },
            ]);

            const recipeVersions = await harness.db.scenarioRecipeVersion.findMany({
                where: { scenarioId: scenario.id, id: { in: result.updatedRecipeVersions.map((rv) => rv.id) } },
                select: { fixtureJson: true },
            });
            expect(recipeVersions).toHaveLength(2);
            expect(recipeVersions.every((rv) => JSON.stringify(rv.fixtureJson) === JSON.stringify(nextRecipe))).toBe(
                true,
            );
        });

        test("updateRecipe creates the pending recipe row when it is missing", async ({ harness }) => {
            const { service, scenario, branchId, app } = await createFixture(
                harness,
                "Scenario Recipe Missing Pending",
            );
            const { snapshotId: pendingSnapshotId } = await harness.request().snapshotEdit.start({ branchId });
            await harness.db.scenarioRecipeVersion.delete({
                where: { scenarioId_snapshotId: { scenarioId: scenario.id, snapshotId: pendingSnapshotId } },
            });
            const nextRecipe = makeRecipe({
                description: "created pending",
                create: { User: [{ _alias: "user1", name: "Created Pending" }] },
            });

            const result = await service.updateRecipe({
                applicationId: app.id,
                organizationId: harness.organizationId,
                scenarioId: scenario.id,
                fixtureJson: JSON.stringify(nextRecipe),
                source: "UI",
            });

            const pendingResult = result.updatedRecipeVersions.find((rv) => rv.target === "main-pending");
            expect(pendingResult?.snapshotId).toBe(pendingSnapshotId);

            const pendingRecipe = await harness.db.scenarioRecipeVersion.findUniqueOrThrow({
                where: { scenarioId_snapshotId: { scenarioId: scenario.id, snapshotId: pendingSnapshotId } },
                select: { id: true, fixtureJson: true },
            });
            expect(pendingRecipe.id).toBe(pendingResult?.id);
            expect(pendingRecipe.fixtureJson).toEqual(nextRecipe);
        });

        test("updateRecipe reaches main's live snapshot and leaves feature and detached snapshots alone", async ({
            harness,
        }) => {
            const { service, scenario, branchId, app } = await createFixture(harness, "Scenario Recipe Branch Fanout");

            // Move main off the snapshot the app was onboarded on, the way the first deploy does. The scenario's
            // active pointer stays behind on the superseded one - that is what used to strand every edit.
            const onboardingSnapshotId = (
                await harness.db.scenarioRecipeVersion.findFirstOrThrow({
                    where: { scenarioId: scenario.id },
                    select: { snapshotId: true },
                })
            ).snapshotId;
            const mainActive = await harness.db.branchSnapshot.create({
                data: { branchId, source: "MANUAL", status: "active" },
            });
            await harness.db.branchSnapshot.update({
                where: { id: onboardingSnapshotId },
                data: { status: "superseded" },
            });
            await harness.db.branch.update({ where: { id: branchId }, data: { activeSnapshotId: mainActive.id } });

            // An open PR branch with its own active snapshot (the recipe its runs were evaluated against, so an edit
            // must not rewrite it), plus a DETACHED snapshot on it - an investigation twin, wired to no pointer -
            // carrying a deliberately different staged recipe.
            const prBranch = await harness.db.branch.create({
                data: {
                    name: "feature/recipe-fanout",
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    prInfo: { create: { applicationId: app.id, prNumber: 77 } },
                },
            });
            const [prActive, twin] = await Promise.all([
                harness.db.branchSnapshot.create({
                    data: { branchId: prBranch.id, source: "WEBHOOK", status: "active" },
                }),
                harness.db.branchSnapshot.create({
                    data: { branchId: prBranch.id, source: "WEBHOOK", status: "active" },
                }),
            ]);
            await harness.db.branch.update({ where: { id: prBranch.id }, data: { activeSnapshotId: prActive.id } });

            const branchRecipe = makeRecipe({
                description: "what the branch forked with",
                create: { User: [{ _alias: "user1", name: "Branch Fork" }] },
            });
            const seedBranchVersion = async (snapshotId: string, fingerprint: string) => {
                const schema = await harness.db.scenarioSchemaSnapshot.create({
                    data: {
                        applicationId: app.id,
                        snapshotId,
                        structureJson: { models: {} },
                        fingerprint: `${fingerprint}-schema`,
                    },
                });
                return harness.db.scenarioRecipeVersion.create({
                    data: {
                        scenarioId: scenario.id,
                        snapshotId,
                        schemaSnapshotId: schema.id,
                        applicationId: app.id,
                        organizationId: harness.organizationId,
                        scenarioNameSnapshot: branchRecipe.name,
                        fingerprint,
                        validationStatus: branchRecipe.validation.status,
                        validationMethod: branchRecipe.validation.method,
                        validationPhase: branchRecipe.validation.phase,
                        fixtureJson: branchRecipe,
                    },
                });
            };
            const prVersionBefore = await seedBranchVersion(prActive.id, "pr-fingerprint");
            const twinVersion = await seedBranchVersion(twin.id, "twin-fingerprint");

            const nextRecipe = makeRecipe({
                description: "written to main",
                create: { User: [{ _alias: "user1", name: "Main Only" }] },
            });
            const result = await service.updateRecipe({
                applicationId: app.id,
                organizationId: harness.organizationId,
                scenarioId: scenario.id,
                fixtureJson: JSON.stringify(nextRecipe),
                source: "UI",
            });

            const written = new Map(result.updatedRecipeVersions.map((rv) => [rv.snapshotId, rv.target]));
            expect(written.get(mainActive.id)).toBe("main-active");
            expect(written.get(onboardingSnapshotId)).toBe("active");
            expect(written.has(prActive.id)).toBe(false);
            expect(written.has(twin.id)).toBe(false);

            // What a run actually reads is keyed by snapshot, so assert the rows themselves.
            const [mainVersion, prAfter, twinAfter] = await Promise.all([
                harness.db.scenarioRecipeVersion.findUniqueOrThrow({
                    where: { scenarioId_snapshotId: { scenarioId: scenario.id, snapshotId: mainActive.id } },
                    select: { id: true, fixtureJson: true },
                }),
                harness.db.scenarioRecipeVersion.findUniqueOrThrow({
                    where: { id: prVersionBefore.id },
                    select: { fixtureJson: true, fingerprint: true },
                }),
                harness.db.scenarioRecipeVersion.findUniqueOrThrow({
                    where: { id: twinVersion.id },
                    select: { fixtureJson: true, fingerprint: true },
                }),
            ]);
            expect(mainVersion.fixtureJson).toEqual(nextRecipe);
            expect(prAfter.fixtureJson).toEqual(branchRecipe);
            expect(prAfter.fingerprint).toBe("pr-fingerprint");
            expect(twinAfter.fixtureJson).toEqual(branchRecipe);
            expect(twinAfter.fingerprint).toBe("twin-fingerprint");

            // The pointer follows main's live snapshot, so the next read and the next write agree with the runs.
            const after = await harness.db.scenario.findUniqueOrThrow({
                where: { id: scenario.id },
                select: { activeRecipeVersionId: true },
            });
            expect(after.activeRecipeVersionId).toBe(mainVersion.id);
        });

        test("updateRecipe rejects invalid JSON and invalid recipe schema", async ({ harness }) => {
            const { service, scenario, app } = await createFixture(harness, "Scenario Recipe Invalid Input");

            await expect(
                service.updateRecipe({
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    scenarioId: scenario.id,
                    fixtureJson: "{",
                    source: "UI",
                }),
            ).rejects.toMatchObject({
                code: "BAD_REQUEST",
                message: "Invalid JSON syntax",
            });

            await expect(
                service.updateRecipe({
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    scenarioId: scenario.id,
                    fixtureJson: JSON.stringify({ name: "standard" }),
                    source: "UI",
                }),
            ).rejects.toMatchObject({
                code: "BAD_REQUEST",
            });
        });

        test("updateRecipe rejects recipe renames", async ({ harness }) => {
            const { service, scenario, app } = await createFixture(harness, "Scenario Recipe Rename Rejected");
            const renamedRecipe = makeRecipe({ name: "renamed" });

            await expect(
                service.updateRecipe({
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    scenarioId: scenario.id,
                    fixtureJson: JSON.stringify(renamedRecipe),
                    source: "UI",
                }),
            ).rejects.toMatchObject({
                code: "BAD_REQUEST",
                message: 'Recipe name must remain "standard"',
            });
        });

        test("updateRecipe remains admin-only through the router", async ({ harness }) => {
            const { scenario, app } = await createFixture(harness, "Scenario Recipe Router Forbidden");
            const before = await harness.db.scenario.findUniqueOrThrow({
                where: { id: scenario.id },
                select: { activeRecipeVersion: { select: { fixtureJson: true } } },
            });

            await expect(
                harness.request().scenarios.updateRecipe({
                    applicationId: app.id,
                    scenarioId: scenario.id,
                    fixtureJson: JSON.stringify(makeRecipe({ description: "should not save" })),
                }),
            ).rejects.toBeInstanceOf(TRPCError);

            const after = await harness.db.scenario.findUniqueOrThrow({
                where: { id: scenario.id },
                select: { activeRecipeVersion: { select: { fixtureJson: true } } },
            });
            expect(after.activeRecipeVersion?.fixtureJson).toEqual(before.activeRecipeVersion?.fixtureJson);
        });

        test("updateRecipe records an attributable history row alongside the write", async ({ harness }) => {
            const { service, scenario, app } = await createFixture(harness, "Scenario Recipe History");
            const nextRecipe = makeRecipe({ create: { User: [{ _alias: "user1", name: "Historic" }] } });

            await service.updateRecipe({
                applicationId: app.id,
                organizationId: harness.organizationId,
                scenarioId: scenario.id,
                fixtureJson: JSON.stringify(nextRecipe),
                source: "MCP",
                actorUserId: harness.userId,
                note: "tried a different name",
            });

            // The planner's own ingest wrote the first row; this write appends rather than
            // replacing, so the recipe that was live before the edit is still recoverable.
            const edits = await harness.db.scenarioRecipeEdit.findMany({
                where: { scenarioId: scenario.id },
                orderBy: { createdAt: "asc" },
                select: { source: true, actorUserId: true, note: true, fixtureJson: true },
            });
            expect(edits.map((edit) => edit.source)).toEqual(["PLANNER", "MCP"]);
            expect(edits[1]).toMatchObject({ actorUserId: harness.userId, note: "tried a different name" });
            expect(edits[1]?.fixtureJson).toMatchObject({ create: { User: [{ name: "Historic" }] } });
        });

        test("updateRecipe rejects a write whose base has moved on, and hands back both sides", async ({ harness }) => {
            const { service, scenario, app } = await createFixture(harness, "Scenario Recipe Conflict");
            const base = await service.getRecipe(app.id, harness.organizationId, scenario.id);
            const baseFingerprint = base.activeRecipeVersion?.fingerprint;

            // Someone else lands first, from the same base.
            await service.updateRecipe({
                applicationId: app.id,
                organizationId: harness.organizationId,
                scenarioId: scenario.id,
                fixtureJson: JSON.stringify(makeRecipe({ description: "landed first" })),
                source: "MCP",
                baseFingerprint,
            });

            // The second write started from the same base, so it is stale.
            const stale = service.updateRecipe({
                applicationId: app.id,
                organizationId: harness.organizationId,
                scenarioId: scenario.id,
                fixtureJson: JSON.stringify(makeRecipe({ description: "would have clobbered" })),
                source: "UI",
                baseFingerprint,
            });

            await expect(stale).rejects.toBeInstanceOf(RecipeConflictError);
            const error = await stale.catch((err: unknown) => err);
            if (!(error instanceof RecipeConflictError)) throw new Error("expected a RecipeConflictError");
            // Both sides of the merge come back: what is stored now, and what the caller started from.
            expect(error.conflict.current).toMatchObject({ description: "landed first" });
            expect(error.conflict.base).toMatchObject({ description: "standard" });
            expect(error.conflict.currentSource).toBe("MCP");

            // The first write is still what is stored - a rejected write changes nothing.
            const after = await service.getRecipe(app.id, harness.organizationId, scenario.id);
            expect(after.fixtureJson).toMatchObject({ description: "landed first" });
        });

        test("updateRecipe accepts a write based on the current revision", async ({ harness }) => {
            const { service, scenario, app } = await createFixture(harness, "Scenario Recipe No Conflict");
            const base = await service.getRecipe(app.id, harness.organizationId, scenario.id);

            await service.updateRecipe({
                applicationId: app.id,
                organizationId: harness.organizationId,
                scenarioId: scenario.id,
                fixtureJson: JSON.stringify(makeRecipe({ description: "based on current" })),
                source: "UI",
                baseFingerprint: base.activeRecipeVersion?.fingerprint,
            });

            const after = await service.getRecipe(app.id, harness.organizationId, scenario.id);
            expect(after.fixtureJson).toMatchObject({ description: "based on current" });
        });

        test("updateRecipe refuses a scenario that belongs to a sibling application", async ({ harness }) => {
            const { app, service } = await createFixture(harness, "Scenario Recipe Owner App");
            const { scenario: siblingScenario } = await createFixture(harness, "Scenario Recipe Sibling App");
            const before = await harness.db.scenario.findUniqueOrThrow({
                where: { id: siblingScenario.id },
                select: { activeRecipeVersion: { select: { fixtureJson: true } } },
            });

            // Same org owns both apps, so an org-only check would let a stale scenarioId
            // aimed at one app silently overwrite another app's recipe.
            await expect(
                service.updateRecipe({
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    scenarioId: siblingScenario.id,
                    fixtureJson: JSON.stringify(makeRecipe({ description: "should not reach the sibling" })),
                    source: "UI",
                }),
            ).rejects.toThrow("Scenario not found");

            const after = await harness.db.scenario.findUniqueOrThrow({
                where: { id: siblingScenario.id },
                select: { activeRecipeVersion: { select: { fixtureJson: true } } },
            });
            expect(after.activeRecipeVersion?.fixtureJson).toEqual(before.activeRecipeVersion?.fixtureJson);
        });

        test("getRecipe refuses a scenario that belongs to a sibling application", async ({ harness }) => {
            const { app, service } = await createFixture(harness, "Scenario Get Owner App");
            const { scenario: siblingScenario } = await createFixture(harness, "Scenario Get Sibling App");

            await expect(service.getRecipe(app.id, harness.organizationId, siblingScenario.id)).rejects.toThrow(
                "Scenario not found",
            );
        });

        test("dryRun rejects a candidate recipe that cannot provision, without touching the stored one", async ({
            harness,
        }) => {
            const { service, app, scenario } = await createFixture(harness, "Scenario Dry Run Bad Candidate");
            const before = await harness.db.scenario.findUniqueOrThrow({
                where: { id: scenario.id },
                select: { activeRecipeVersion: { select: { fixtureJson: true } } },
            });

            // Even with `save`, a candidate that cannot resolve is rejected before any
            // provisioning attempt - so a broken recipe can never become the active one.
            const result = await service.dryRun(app.id, harness.organizationId, scenario.id, {
                recipe: makeRecipe({ create: { User: [{ email: "{{ownerEmail}}" }] } }),
                save: true,
            });

            expect(result.success).toBe(false);
            expect(result.phase).toBe("recipe");
            expect(result.saved).toBe(false);
            const after = await harness.db.scenario.findUniqueOrThrow({
                where: { id: scenario.id },
                select: { activeRecipeVersion: { select: { fixtureJson: true } } },
            });
            expect(after.activeRecipeVersion?.fixtureJson).toEqual(before.activeRecipeVersion?.fixtureJson);
        });

        test("dryRun rejects a candidate recipe that renames the scenario", async ({ harness }) => {
            const { service, app, scenario } = await createFixture(harness, "Scenario Dry Run Candidate Rename");

            await expect(
                service.dryRun(app.id, harness.organizationId, scenario.id, {
                    recipe: makeRecipe({ name: "renamed" }),
                }),
            ).rejects.toThrow(TRPCError);
        });

        test("listInstances flags runs whose recipe has changed since", async ({ harness }) => {
            const { service, scenario, app } = await createFixture(harness, "Scenario Instance Provenance");
            const before = await service.getRecipe(app.id, harness.organizationId, scenario.id);
            const originalFingerprint = before.activeRecipeVersion?.fingerprint ?? "";

            // One run against the recipe as it stands, one against a fingerprint that never was.
            await harness.db.scenarioInstance.create({
                data: {
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    scenarioId: scenario.id,
                    status: "UP_SUCCESS",
                    recipeFingerprint: originalFingerprint,
                },
            });
            await harness.db.scenarioInstance.create({
                data: {
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    scenarioId: scenario.id,
                    status: "UP_SUCCESS",
                    recipeFingerprint: "a-recipe-that-has-since-been-replaced",
                },
            });

            const instances = await service.listInstances(scenario.id, harness.organizationId);

            const bySuperseded = instances.map((instance) => instance.recipeSuperseded).sort();
            expect(bySuperseded).toEqual([false, true]);
        });

        test("dryRun rejects a scenario that belongs to another application", async ({ harness }) => {
            const { service, app } = await createFixture(harness, "Scenario Dry Run Owner App");
            const { scenario: foreignScenario } = await createFixture(harness, "Scenario Dry Run Other App");

            // dryRun scopes the scenario to its application, so a scenario from another
            // app is rejected up front - a caller can't run another tenant's recipe
            // against their own (SDK-controlled) app.
            await expect(service.dryRun(app.id, harness.organizationId, foreignScenario.id)).rejects.toThrow(
                "Scenario not found",
            );
        });
    },
});
