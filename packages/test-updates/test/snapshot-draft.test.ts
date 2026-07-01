import { SnapshotStatus } from "@autonoma/db";
import { expect } from "vitest";
import { BranchAlreadyHasPendingSnapshotError, SnapshotDraft, SnapshotNotPendingError } from "../src/snapshot-draft";
import { findTestCase, testUpdateSuite } from "./harness";

testUpdateSuite({
    name: "SnapshotDraft",
    cases: (test) => {
        // -- start() --

        test("start: creates a pending snapshot on an empty branch", async ({ harness, seedResult: { branchId } }) => {
            const draft = await SnapshotDraft.start({ db: harness.db, branchId });

            expect(draft.snapshotId).toBeDefined();

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { pendingSnapshotId: true },
            });
            expect(branch.pendingSnapshotId).toBe(draft.snapshotId);
        });

        test("start: copies test case assignments from active snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            await first.addTestCase({
                folderId,
                name: "Login test",
                slug: "login-test",
                description: "Tests login",
                plan: "Go to login page",
            });
            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });
            const info = await second.currentTestSuiteInfo();

            expect(info.testCases).toHaveLength(1);
            const tc = findTestCase(info, "login-test");
            expect(tc.name).toBe("Login test");
            expect(tc.plan?.prompt).toBe("Go to login page");
        });

        test("start: carries stepsId forward uniformly for every assignment", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            const { testCaseId, planId } = await first.addTestCase({
                folderId,
                name: "Has steps",
                slug: "has-steps",
                description: "Carries its replayable steps forward",
                plan: "Open homepage",
            });

            const steps = await harness.db.stepInputList.create({
                data: { planId, organizationId },
                select: { id: true },
            });
            await harness.db.testCaseAssignment.update({
                where: { snapshotId_testCaseId: { snapshotId: first.snapshotId, testCaseId } },
                data: { stepsId: steps.id },
            });

            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });

            const carried = await harness.db.testCaseAssignment.findUniqueOrThrow({
                where: { snapshotId_testCaseId: { snapshotId: second.snapshotId, testCaseId } },
                select: { stepsId: true },
            });
            // Steps survive the copy so the test re-runs next snapshot - the auto-fix probe.
            expect(carried.stepsId).toBe(steps.id);
        });

        test("start: copies scenario recipe versions from active snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });

            const scenario = await harness.db.scenario.create({
                data: { name: "standard", applicationId, organizationId },
                select: { id: true },
            });
            const schemaSnapshot = await harness.db.scenarioSchemaSnapshot.create({
                data: {
                    applicationId,
                    snapshotId: first.snapshotId,
                    structureJson: { models: {} },
                    fingerprint: "abc123",
                },
                select: { id: true },
            });
            const recipeVersion = await harness.db.scenarioRecipeVersion.create({
                data: {
                    scenarioId: scenario.id,
                    snapshotId: first.snapshotId,
                    schemaSnapshotId: schemaSnapshot.id,
                    applicationId,
                    organizationId,
                    scenarioNameSnapshot: "standard",
                    fingerprint: "recipe-fp",
                    validationStatus: "validated",
                    validationMethod: "endpoint-up-down",
                    validationPhase: "ok",
                    fixtureJson: { name: "standard", create: { User: [{ name: "alice" }] } },
                },
                select: { id: true },
            });
            await harness.db.scenario.update({
                where: { id: scenario.id },
                data: { activeRecipeVersionId: recipeVersion.id },
            });

            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });

            const copiedSchemas = await harness.db.scenarioSchemaSnapshot.findMany({
                where: { snapshotId: second.snapshotId },
            });
            expect(copiedSchemas).toHaveLength(1);
            expect(copiedSchemas[0]?.fingerprint).toBe("abc123");
            expect(copiedSchemas[0]?.id).not.toBe(schemaSnapshot.id);

            const copiedRecipes = await harness.db.scenarioRecipeVersion.findMany({
                where: { snapshotId: second.snapshotId },
            });
            expect(copiedRecipes).toHaveLength(1);
            expect(copiedRecipes[0]?.scenarioId).toBe(scenario.id);
            expect(copiedRecipes[0]?.fingerprint).toBe("recipe-fp");
            expect(copiedRecipes[0]?.schemaSnapshotId).toBe(copiedSchemas[0]?.id);
            expect(copiedRecipes[0]?.id).not.toBe(recipeVersion.id);
        });

        test("start: copies test case assignments from main branch active snapshot on brand new branch", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const mainBranchId = await harness.createBranch(organizationId, applicationId);
            await harness.db.application.update({
                where: { id: applicationId },
                data: { mainBranchId },
            });

            const mainDraft = await SnapshotDraft.start({ db: harness.db, branchId: mainBranchId });
            await mainDraft.addTestCase({
                folderId,
                name: "Main inherited test",
                slug: "main-inherited-test",
                description: "Tests main inheritance",
                plan: "Go to main inherited page",
            });
            await mainDraft.activate();

            const mainBranch = await harness.db.branch.findUniqueOrThrow({
                where: { id: mainBranchId },
                select: { activeSnapshotId: true },
            });

            const prBranchId = await harness.createBranch(organizationId, applicationId, { prNumber: 42 });

            const prDraft = await SnapshotDraft.start({ db: harness.db, branchId: prBranchId });
            const info = await prDraft.currentTestSuiteInfo();

            expect(info.testCases).toHaveLength(1);
            const tc = findTestCase(info, "main-inherited-test");
            expect(tc.name).toBe("Main inherited test");
            expect(tc.plan?.prompt).toBe("Go to main inherited page");

            const prSnapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: prDraft.snapshotId },
                select: { prevSnapshotId: true },
            });
            expect(prSnapshot.prevSnapshotId).toBe(mainBranch.activeSnapshotId);
        });

        test("start: produces an empty snapshot when main branch has no active snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const mainBranchId = await harness.createBranch(organizationId, applicationId);
            await harness.db.application.update({
                where: { id: applicationId },
                data: { mainBranchId },
            });

            const prBranchId = await harness.createBranch(organizationId, applicationId, { prNumber: 7 });

            const prDraft = await SnapshotDraft.start({ db: harness.db, branchId: prBranchId });
            const info = await prDraft.currentTestSuiteInfo();

            expect(info.testCases).toHaveLength(0);
        });

        test("start: throws BranchAlreadyHasPendingSnapshotError when branch has pending snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            await SnapshotDraft.start({ db: harness.db, branchId });

            await expect(SnapshotDraft.start({ db: harness.db, branchId })).rejects.toThrow(
                BranchAlreadyHasPendingSnapshotError,
            );
        });

        // -- fromBranch() --

        test("fromBranch: loads an existing pending snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const draft = await SnapshotDraft.start({ db: harness.db, branchId });

            const loaded = await SnapshotDraft.loadPending({ db: harness.db, branchId });

            expect(loaded.snapshotId).toBe(draft.snapshotId);
            expect(loaded.applicationId).toBe(applicationId);
            expect(loaded.organizationId).toBe(organizationId);
        });

        test("fromBranch: throws SnapshotNotPendingError when no pending snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const draft = await SnapshotDraft.start({ db: harness.db, branchId });
            await draft.activate();

            await expect(SnapshotDraft.loadPending({ db: harness.db, branchId })).rejects.toThrow(
                SnapshotNotPendingError,
            );
        });

        // -- loadById() --

        test("loadById: loads a pending snapshot by its id", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const draft = await SnapshotDraft.start({ db: harness.db, branchId });

            const loaded = await SnapshotDraft.loadById({ db: harness.db, snapshotId: draft.snapshotId });

            expect(loaded.snapshotId).toBe(draft.snapshotId);
            expect(loaded.branchId).toBe(branchId);
            expect(loaded.applicationId).toBe(applicationId);
            expect(loaded.organizationId).toBe(organizationId);
        });

        test("loadById: throws SnapshotNotPendingError when snapshot is not processing", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const draft = await SnapshotDraft.start({ db: harness.db, branchId });
            await draft.activate();

            await expect(SnapshotDraft.loadById({ db: harness.db, snapshotId: draft.snapshotId })).rejects.toThrow(
                SnapshotNotPendingError,
            );
        });

        test("loadById: throws SnapshotNotPendingError when snapshot does not exist", async ({ harness }) => {
            await expect(SnapshotDraft.loadById({ db: harness.db, snapshotId: "nonexistent-id" })).rejects.toThrow(
                SnapshotNotPendingError,
            );
        });

        test("loadById: loads the requested snapshot even after a newer pending snapshot has replaced it", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            await first.addTestCase({
                folderId,
                name: "First",
                slug: "first",
                description: "first",
                plan: "first",
            });
            await first.cancel();

            // Branch now has no pending snapshot; start a fresh one
            const second = await SnapshotDraft.start({ db: harness.db, branchId });

            // loadById for first (which was cancelled) should throw - but loadById for second works
            await expect(SnapshotDraft.loadById({ db: harness.db, snapshotId: first.snapshotId })).rejects.toThrow(
                SnapshotNotPendingError,
            );

            const loadedSecond = await SnapshotDraft.loadById({ db: harness.db, snapshotId: second.snapshotId });
            expect(loadedSecond.snapshotId).toBe(second.snapshotId);
        });

        // -- activate() --

        test("activate: transitions snapshot to active and supersedes previous", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });
            await second.activate();

            const firstSnapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: first.snapshotId },
                select: { status: true },
            });
            expect(firstSnapshot.status).toBe(SnapshotStatus.superseded);

            const secondSnapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: second.snapshotId },
                select: { status: true },
            });
            expect(secondSnapshot.status).toBe(SnapshotStatus.active);

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { activeSnapshotId: true, pendingSnapshotId: true },
            });
            expect(branch.activeSnapshotId).toBe(second.snapshotId);
            expect(branch.pendingSnapshotId).toBeNull();
        });

        test("activate: throws SnapshotNotPendingError if already activated", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);
            await draft.activate();

            await expect(draft.activate()).rejects.toThrow(SnapshotNotPendingError);
        });

        // -- addTestCase / updatePlan / removeTestCase --

        test("addTestCase: creates test case with plan and assignment", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);

            await draft.addTestCase({
                folderId,
                name: "Checkout test",
                slug: "checkout-test",
                description: "Tests checkout flow",
                plan: "Add item to cart and checkout",
            });

            const info = await draft.currentTestSuiteInfo();

            expect(info.testCases).toHaveLength(1);
            const tc = findTestCase(info, "checkout-test");
            expect(tc.name).toBe("Checkout test");
            expect(tc.plan?.prompt).toBe("Add item to cart and checkout");
            expect(tc.steps).toBeNull();
        });

        test("updatePlan: creates new plan and clears steps", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);

            const { testCaseId, planId: originalPlanId } = await draft.addTestCase({
                folderId,
                name: "Update plan test",
                slug: "update-plan-test",
                description: "Tests plan update",
                plan: "Original plan",
            });

            const { planId: newPlanId } = await draft.updatePlan({
                testCaseId,
                plan: "Updated plan",
            });
            expect(newPlanId).not.toBe(originalPlanId);

            const info = await draft.currentTestSuiteInfo();
            const tc = findTestCase(info, "update-plan-test");
            expect(tc.plan?.prompt).toBe("Updated plan");
            expect(tc.plan?.id).toBe(newPlanId);
            expect(tc.steps).toBeNull();
        });

        test("removeTestCase: deletes the assignment", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);

            const { testCaseId } = await draft.addTestCase({
                folderId,
                name: "Remove me",
                slug: "remove-me",
                description: "Will be removed",
                plan: "Some plan",
            });

            await draft.removeTestCase(testCaseId);

            const info = await draft.currentTestSuiteInfo();
            expect(info.testCases).toHaveLength(0);
        });

        test("removeTestCase: is a no-op when the assignment is already gone", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);

            const { testCaseId } = await draft.addTestCase({
                folderId,
                name: "Remove twice",
                slug: "remove-twice",
                description: "Will be removed twice",
                plan: "Some plan",
            });

            await draft.removeTestCase(testCaseId);
            // Second removal must not throw even though the assignment is gone.
            await expect(draft.removeTestCase(testCaseId)).resolves.toBeUndefined();

            const info = await draft.currentTestSuiteInfo();
            expect(info.testCases).toHaveLength(0);
        });

        // -- updateManySteps() --

        test("updateManySteps: updates steps for multiple test cases", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const draft = await harness.startDraft(organizationId, applicationId);

            const { planId: planA } = await draft.addTestCase({
                folderId,
                name: "Batch A",
                slug: "batch-a",
                description: "First",
                plan: "Plan A",
            });
            const { planId: planB } = await draft.addTestCase({
                folderId,
                name: "Batch B",
                slug: "batch-b",
                description: "Second",
                plan: "Plan B",
            });

            const stepsA = await harness.db.stepInputList.create({ data: { planId: planA, organizationId } });
            const stepsB = await harness.db.stepInputList.create({ data: { planId: planB, organizationId } });

            const info = await draft.currentTestSuiteInfo();
            const tcA = findTestCase(info, "batch-a");
            const tcB = findTestCase(info, "batch-b");

            await draft.updateManySteps([
                { testCaseId: tcA.id, stepsId: stepsA.id },
                { testCaseId: tcB.id, stepsId: stepsB.id },
            ]);

            const updated = await draft.currentTestSuiteInfo();
            expect(findTestCase(updated, "batch-a").steps?.id).toBe(stepsA.id);
            expect(findTestCase(updated, "batch-b").steps?.id).toBe(stepsB.id);
        });

        // -- cancel() --

        test("cancel: marks snapshot cancelled and clears branch pointer, preserving data", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const draft = await SnapshotDraft.start({ db: harness.db, branchId });

            await draft.addTestCase({
                folderId,
                name: "Cancel test",
                slug: "cancel-test",
                description: "Will be cancelled",
                plan: "Some plan",
                scenarioId: undefined as unknown as string,
            });

            await draft.cancel();

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { pendingSnapshotId: true },
            });
            expect(branch.pendingSnapshotId).toBeNull();

            const snapshot = await harness.db.branchSnapshot.findUnique({
                where: { id: draft.snapshotId },
                select: { status: true },
            });
            expect(snapshot?.status).toBe(SnapshotStatus.cancelled);

            // Assignments are preserved for observability, not deleted.
            const assignmentCount = await harness.db.testCaseAssignment.count({
                where: { snapshotId: draft.snapshotId },
            });
            expect(assignmentCount).toBeGreaterThan(0);
        });

        test("cancel: after cancel, loadPending throws", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const draft = await SnapshotDraft.start({ db: harness.db, branchId });
            await draft.cancel();

            await expect(SnapshotDraft.loadPending({ db: harness.db, branchId })).rejects.toThrow(
                SnapshotNotPendingError,
            );
        });

        // -- getChanges() --

        test("getChanges: returns empty for first snapshot with no modifications", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const draft = await SnapshotDraft.start({ db: harness.db, branchId });

            const changes = await draft.getChanges();
            expect(changes).toHaveLength(0);
        });

        test("getChanges: returns added for new test cases on first snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const draft = await SnapshotDraft.start({ db: harness.db, branchId });

            await draft.addTestCase({
                folderId,
                name: "New test",
                slug: "new-test",
                description: "A new test",
                plan: "New plan",
                scenarioId: undefined as unknown as string,
            });

            const changes = await draft.getChanges();
            expect(changes).toHaveLength(1);
            expect(changes[0]?.type).toBe("added");
            expect(changes[0]?.testCaseName).toBe("New test");
            if (changes[0]?.type === "added") {
                expect(changes[0].plan).toBe("New plan");
            }
        });

        test("getChanges: detects added tests after start from active snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            await first.addTestCase({
                folderId,
                name: "Existing test",
                slug: "existing-test",
                description: "Already exists",
                plan: "Existing plan",
                scenarioId: undefined as unknown as string,
            });
            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });
            await second.addTestCase({
                folderId,
                name: "Brand new test",
                slug: "brand-new-test",
                description: "Just added",
                plan: "Brand new plan",
                scenarioId: undefined as unknown as string,
            });

            const changes = await second.getChanges();
            expect(changes).toHaveLength(1);
            expect(changes[0]?.type).toBe("added");
            expect(changes[0]?.testCaseName).toBe("Brand new test");
        });

        test("getChanges: detects removed tests", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            const { testCaseId } = await first.addTestCase({
                folderId,
                name: "Will be removed",
                slug: "will-be-removed",
                description: "To remove",
                plan: "Remove plan",
                scenarioId: undefined as unknown as string,
            });
            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });
            await second.removeTestCase(testCaseId);

            const changes = await second.getChanges();
            expect(changes).toHaveLength(1);
            expect(changes[0]?.type).toBe("removed");
            expect(changes[0]?.testCaseName).toBe("Will be removed");
            if (changes[0]?.type === "removed") {
                expect(changes[0].previousPlan).toBe("Remove plan");
            }
        });

        test("getChanges: detects updated tests with both plans", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            const { testCaseId } = await first.addTestCase({
                folderId,
                name: "Update me",
                slug: "update-me",
                description: "Will be updated",
                plan: "Old plan",
                scenarioId: undefined as unknown as string,
            });
            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });
            await second.updatePlan({
                testCaseId,
                plan: "New plan",
                scenarioId: undefined as unknown as string,
            });

            const changes = await second.getChanges();
            expect(changes).toHaveLength(1);
            expect(changes[0]?.type).toBe("updated");
            if (changes[0]?.type === "updated") {
                expect(changes[0].plan).toBe("New plan");
                expect(changes[0].previousPlan).toBe("Old plan");
            }
        });

        test("getChanges: ignores unchanged tests", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            await first.addTestCase({
                folderId,
                name: "Unchanged test",
                slug: "unchanged-test",
                description: "Stays the same",
                plan: "Same plan",
                scenarioId: undefined as unknown as string,
            });
            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });

            const changes = await second.getChanges();
            expect(changes).toHaveLength(0);
        });

        test("getChanges: returns mix of added, removed, and updated", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            await first.addTestCase({
                folderId,
                name: "Stays unchanged",
                slug: "stays-unchanged",
                description: "",
                plan: "Unchanged plan",
                scenarioId: undefined as unknown as string,
            });
            const { testCaseId: updateId } = await first.addTestCase({
                folderId,
                name: "Gets updated",
                slug: "gets-updated",
                description: "",
                plan: "Before update",
                scenarioId: undefined as unknown as string,
            });
            const { testCaseId: removeId } = await first.addTestCase({
                folderId,
                name: "Gets removed",
                slug: "gets-removed",
                description: "",
                plan: "Before remove",
                scenarioId: undefined as unknown as string,
            });
            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });
            await second.addTestCase({
                folderId,
                name: "Newly added",
                slug: "newly-added",
                description: "",
                plan: "New plan",
                scenarioId: undefined as unknown as string,
            });
            await second.updatePlan({
                testCaseId: updateId,
                plan: "After update",
                scenarioId: undefined as unknown as string,
            });
            await second.removeTestCase(removeId);

            const changes = await second.getChanges();
            expect(changes).toHaveLength(3);

            const added = changes.find((c) => c.type === "added");
            const updated = changes.find((c) => c.type === "updated");
            const removed = changes.find((c) => c.type === "removed");

            expect(added).toBeDefined();
            expect(added?.testCaseName).toBe("Newly added");

            expect(updated).toBeDefined();
            expect(updated?.testCaseName).toBe("Gets updated");

            expect(removed).toBeDefined();
            expect(removed?.testCaseName).toBe("Gets removed");
        });
        // -- revertTestCase() --

        test("revertTestCase: deletes newly added test on first snapshot (no prevSnapshot)", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const draft = await SnapshotDraft.start({ db: harness.db, branchId });

            const { testCaseId } = await draft.addTestCase({
                folderId,
                name: "Brand new",
                slug: "brand-new",
                description: "Will be reverted",
                plan: "Some plan",
            });

            await draft.revertTestCase(testCaseId);

            const info = await draft.currentTestSuiteInfo();
            expect(info.testCases).toHaveLength(0);

            // Test case record itself should be deleted
            const tc = await harness.db.testCase.findUnique({ where: { id: testCaseId } });
            expect(tc).toBeNull();
        });

        test("revertTestCase: deletes newly added test on second snapshot (no previous assignment)", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            await first.addTestCase({
                folderId,
                name: "Revert existing base",
                slug: "revert-existing-base",
                description: "Already here",
                plan: "Existing plan",
            });
            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });
            const { testCaseId } = await second.addTestCase({
                folderId,
                name: "Revert new in second",
                slug: "revert-new-in-second",
                description: "Added in second snapshot",
                plan: "New plan",
            });

            await second.revertTestCase(testCaseId);

            const info = await second.currentTestSuiteInfo();
            expect(info.testCases).toHaveLength(1);
            expect(info.testCases[0]?.name).toBe("Revert existing base");

            const tc = await harness.db.testCase.findUnique({ where: { id: testCaseId } });
            expect(tc).toBeNull();
        });

        test("revertTestCase: restores previous assignment for updated test", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            const { testCaseId } = await first.addTestCase({
                folderId,
                name: "Revert update target",
                slug: "revert-update-target",
                description: "Will be updated then reverted",
                plan: "Original plan",
            });
            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });
            await second.updatePlan({ testCaseId, plan: "Updated plan" });

            // Verify the update took effect
            let info = await second.currentTestSuiteInfo();
            const updated = findTestCase(info, "revert-update-target");
            expect(updated.plan?.prompt).toBe("Updated plan");

            await second.revertTestCase(testCaseId);

            // Should be back to original plan
            info = await second.currentTestSuiteInfo();
            const reverted = findTestCase(info, "revert-update-target");
            expect(reverted.plan?.prompt).toBe("Original plan");
        });

        test("revertTestCase: restores assignment for removed test", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            const { testCaseId } = await first.addTestCase({
                folderId,
                name: "Revert removal target",
                slug: "revert-removal-target",
                description: "Will be removed then reverted",
                plan: "Original plan",
            });
            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });
            await second.removeTestCase(testCaseId);

            let info = await second.currentTestSuiteInfo();
            expect(info.testCases).toHaveLength(0);

            await second.revertTestCase(testCaseId);

            info = await second.currentTestSuiteInfo();
            expect(info.testCases).toHaveLength(1);
            const reverted = findTestCase(info, "revert-removal-target");
            expect(reverted.plan?.prompt).toBe("Original plan");
        });

        test("revertTestCase: clears changes after revert", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            const { testCaseId } = await first.addTestCase({
                folderId,
                name: "Revert changes check",
                slug: "revert-changes-check",
                description: "Check getChanges after revert",
                plan: "Original plan",
            });
            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });
            await second.updatePlan({ testCaseId, plan: "Modified plan" });

            let changes = await second.getChanges();
            expect(changes).toHaveLength(1);
            expect(changes[0]?.type).toBe("updated");

            await second.revertTestCase(testCaseId);

            changes = await second.getChanges();
            expect(changes).toHaveLength(0);
        });

        test("revertTestCase: deletes pending generations for the test case", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            const { testCaseId, planId } = await first.addTestCase({
                folderId,
                name: "Revert gen test",
                slug: "revert-gen-test",
                description: "Has a pending generation",
                plan: "Some plan",
            });

            // Create a pending generation for this test case
            await harness.db.testGeneration.create({
                data: {
                    testPlan: { connect: { id: planId } },
                    status: "pending",
                    snapshot: { connect: { id: first.snapshotId } },
                    organization: { connect: { id: organizationId } },
                },
            });

            await first.revertTestCase(testCaseId);

            const generations = await harness.db.testGeneration.findMany({
                where: { snapshotId: first.snapshotId, testPlan: { testCaseId } },
            });
            expect(generations).toHaveLength(0);
        });

        test("revertTestCase: deletes pending generations when discarding an added test on second snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            await first.addTestCase({
                folderId,
                name: "Revert gen base",
                slug: "revert-gen-base",
                description: "Existing test",
                plan: "Base plan",
            });
            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });
            const { testCaseId, planId } = await second.addTestCase({
                folderId,
                name: "Revert gen added",
                slug: "revert-gen-added",
                description: "Newly added with generation",
                plan: "New plan",
            });

            await harness.db.testGeneration.create({
                data: {
                    testPlan: { connect: { id: planId } },
                    status: "pending",
                    snapshot: { connect: { id: second.snapshotId } },
                    organization: { connect: { id: organizationId } },
                },
            });

            await second.revertTestCase(testCaseId);

            const generations = await harness.db.testGeneration.findMany({
                where: { snapshotId: second.snapshotId, testPlan: { testCaseId } },
            });
            expect(generations).toHaveLength(0);

            const tc = await harness.db.testCase.findUnique({ where: { id: testCaseId } });
            expect(tc).toBeNull();
        });

        test("revertTestCase: deletes pending generations when discarding an updated test", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);

            const first = await SnapshotDraft.start({ db: harness.db, branchId });
            const { testCaseId } = await first.addTestCase({
                folderId,
                name: "Revert gen updated",
                slug: "revert-gen-updated",
                description: "Will be updated",
                plan: "Original plan",
            });
            await first.activate();

            const second = await SnapshotDraft.start({ db: harness.db, branchId });
            const { planId: newPlanId } = await second.updatePlan({ testCaseId, plan: "Updated plan" });

            await harness.db.testGeneration.create({
                data: {
                    testPlan: { connect: { id: newPlanId } },
                    status: "pending",
                    snapshot: { connect: { id: second.snapshotId } },
                    organization: { connect: { id: organizationId } },
                },
            });

            await second.revertTestCase(testCaseId);

            const generations = await harness.db.testGeneration.findMany({
                where: { snapshotId: second.snapshotId, testPlan: { testCaseId } },
            });
            expect(generations).toHaveLength(0);

            // Plan should be reverted to original
            const info = await second.currentTestSuiteInfo();
            const reverted = findTestCase(info, "revert-gen-updated");
            expect(reverted.plan?.prompt).toBe("Original plan");
        });
    },
});
