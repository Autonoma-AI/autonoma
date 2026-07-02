import { createDetachedSnapshot } from "@autonoma/test-updates";
import { expect } from "vitest";
import { EditPersister, MergeInputsReader } from "../../src";
import { investigationDbSuite } from "../harness";

investigationDbSuite({
    name: "MergeInputsReader",
    cases: (test) => {
        test("derives the branch's new test and modification from the twin, enriched with main's suite", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            // Main's suite: the branch's active (main-representing) snapshot with one test.
            const { branchId, snapshotId: mainSnapshotId } = await harness.setupTestCase(
                organizationId,
                application.id,
                "checkout-flow",
            );

            // The investigation twin, forked from that suite, with one modification + one added test persisted.
            const twin = await createDetachedSnapshot({ db: harness.db, branchId, organizationId });
            if (twin == null) throw new Error("expected a detached twin");
            await new EditPersister(harness.db).persist(
                twin.snapshotId,
                organizationId,
                [{ slug: "checkout-flow", plan: "revised checkout plan" }],
                [{ name: "Coupon test", description: "coupon applies a discount", plan: "new coupon plan" }],
            );

            const inputs = await new MergeInputsReader(harness.db).read(
                twin.snapshotId,
                mainSnapshotId,
                organizationId,
            );

            // Exactly the two edits, nothing for the untouched login-flow.
            const modification = inputs.edits.find((edit) => edit.kind === "modification");
            const newTest = inputs.edits.find((edit) => edit.kind === "new_test");
            expect(inputs.edits).toHaveLength(2);

            expect(modification).toMatchObject({ ref: "checkout-flow", proposedPlan: "revised checkout plan" });
            // basePlan is the fork-point plan; mainCurrentPlan is main's plan for the same slug (here unchanged).
            expect(modification?.basePlan).toBe("initial plan");
            expect(modification?.mainCurrentPlan).toBe("initial plan");

            expect(newTest).toMatchObject({ name: "Coupon test", proposedPlan: "new coupon plan" });
            expect(newTest?.ref).toContain("coupon");
            // The real persisted test-case description is carried through (not a plan-frontmatter summary).
            expect(newTest?.description).toBe("coupon applies a discount");
            // A brand-new test has no baseline on main.
            expect(newTest?.basePlan).toBeUndefined();

            // Main's suite carries its current tests (the new coupon test lives on the twin, not main).
            expect(inputs.mainSuite.map((entry) => entry.slug)).toEqual(["checkout-flow"]);
        });

        test("returns no edits when the twin has no diff from its baseline", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const { branchId, snapshotId: mainSnapshotId } = await harness.setupTestCase(
                organizationId,
                application.id,
                "unchanged-flow",
            );
            const twin = await createDetachedSnapshot({ db: harness.db, branchId, organizationId });
            if (twin == null) throw new Error("expected a detached twin");

            const inputs = await new MergeInputsReader(harness.db).read(
                twin.snapshotId,
                mainSnapshotId,
                organizationId,
            );

            expect(inputs.edits).toEqual([]);
            expect(inputs.mainSuite).toHaveLength(1);
            expect(inputs.recipeEdits).toEqual([]);
        });

        test("derives a recipe edit when the twin's create graph differs from its fork-point baseline", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const { branchId, snapshotId: mainSnapshotId } = await harness.setupTestCase(
                organizationId,
                application.id,
                "recipe-diff-flow",
            );
            // Main's recipe (the fork source) seeds an empty orders list.
            const scenarioId = "scenario-orders-diff";
            await harness.createScenarioRecipe(mainSnapshotId, {
                scenarioId,
                scenarioName: "Orders Diff",
                applicationId: application.id,
                organizationId,
                createGraph: { orders: [] },
            });

            // The twin forks the recipe (create = {orders: []}), then the branch's repair changes it.
            const twin = await createDetachedSnapshot({ db: harness.db, branchId, organizationId });
            if (twin == null) throw new Error("expected a detached twin");
            await harness.db.scenarioRecipeVersion.update({
                where: { scenarioId_snapshotId: { scenarioId, snapshotId: twin.snapshotId } },
                data: {
                    fixtureJson: {
                        name: "Orders Diff",
                        description: "seed for tests",
                        create: { orders: [{ total: 10 }] },
                        validation: { status: "validated", method: "endpoint-up-down", phase: "ok" },
                    },
                },
            });

            const inputs = await new MergeInputsReader(harness.db).read(
                twin.snapshotId,
                mainSnapshotId,
                organizationId,
            );

            expect(inputs.recipeEdits).toHaveLength(1);
            const recipeEdit = inputs.recipeEdits[0];
            expect(recipeEdit?.scenarioId).toBe(scenarioId);
            expect(JSON.parse(recipeEdit?.proposedCreateGraph ?? "{}")).toEqual({ orders: [{ total: 10 }] });
            // base = fork point (empty), main = current main recipe (also empty here - nobody else changed it).
            expect(JSON.parse(recipeEdit?.baseCreateGraph ?? "null")).toEqual({ orders: [] });
            expect(JSON.parse(recipeEdit?.mainCreateGraph ?? "null")).toEqual({ orders: [] });
        });

        test("returns no recipe edit when the twin's create graph matches its baseline", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const { branchId, snapshotId: mainSnapshotId } = await harness.setupTestCase(
                organizationId,
                application.id,
                "recipe-match-flow",
            );
            await harness.createScenarioRecipe(mainSnapshotId, {
                scenarioId: "scenario-orders-match",
                scenarioName: "Orders Match",
                applicationId: application.id,
                organizationId,
                createGraph: { orders: [] },
            });
            // Fork but never change the twin's recipe.
            const twin = await createDetachedSnapshot({ db: harness.db, branchId, organizationId });
            if (twin == null) throw new Error("expected a detached twin");

            const inputs = await new MergeInputsReader(harness.db).read(
                twin.snapshotId,
                mainSnapshotId,
                organizationId,
            );

            expect(inputs.recipeEdits).toEqual([]);
        });
    },
});
