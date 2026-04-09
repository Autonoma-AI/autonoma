import { afterEach, describe, expect, it } from "vitest";
import { DiffsAgent } from "../src";
import { createAuthFlowFixture } from "../test/fixtures";
import { createChatFixture } from "../test/fixtures";
import { createCheckoutFixture } from "../test/fixtures";
import { createDataTableFixture } from "../test/fixtures";
import { createEcommerceFixture } from "../test/fixtures";
import { createFormProjectFixture } from "../test/fixtures";
import { createKanbanFixture } from "../test/fixtures";
import { createSettingsPageFixture } from "../test/fixtures";
import { createTodoAppFixture } from "../test/fixtures";
import { type ScenarioFixture, buildMockCallbacks } from "../test/fixtures";
import { createEvalModel } from "./create-model";

const AGENT_TIMEOUT = 300_000;
const EVAL_REPEATS = 3;

describe("diffs agent evals", () => {
    let fixture: ScenarioFixture | undefined;

    afterEach(async () => {
        await fixture?.cleanup();
        fixture = undefined;
    });

    describe("todo app - button rename, delete removed, filter added", () => {
        it(
            "should modify the add-todo test, quarantine the delete-todo test, and add a filter test",
            { repeats: EVAL_REPEATS, timeout: AGENT_TIMEOUT },
            async () => {
                fixture = await createTodoAppFixture();
                const callbacks = buildMockCallbacks(fixture.testRunResults);
                const { model, registry } = createEvalModel();

                const agent = new DiffsAgent({
                    model,
                    workingDirectory: fixture.repoDir,
                    callbacks,
                    maxSteps: 40,
                });

                const result = await agent.analyze(fixture.input);

                console.log("=== Todo App Results ===");
                console.log("Reasoning:", result.reasoning);
                console.log("Test actions:", JSON.stringify(result.testActions, null, 2));
                console.log("New tests:", JSON.stringify(result.newTests, null, 2));
                console.log("Bug reports:", JSON.stringify(result.bugReports, null, 2));
                console.log("Skill updates:", JSON.stringify(result.skillUpdates, null, 2));
                console.log("Model usage:", JSON.stringify(registry.modelUsage, null, 2));

                // Should have run both tests
                expect(callbacks.calls.triggerTestsAndWait).toContain("test-add-todo");
                expect(callbacks.calls.triggerTestsAndWait).toContain("test-delete-todo");

                // Add-todo test failed because button was renamed - should be modified, not quarantined
                const modifyActions = result.testActions.filter((a) => a.type === "modify");
                const hasAddTodoModify = modifyActions.some((a) => a.slug === "test-add-todo");
                expect(hasAddTodoModify).toBe(true);

                // Delete-todo test failed because the flow was removed - should be quarantined
                const quarantineActions = result.testActions.filter((a) => a.type === "quarantine");
                const hasDeleteQuarantine = quarantineActions.some((a) => a.slug === "test-delete-todo");
                expect(hasDeleteQuarantine).toBe(true);

                // Should suggest at least one new test for the filter feature
                expect(result.newTests.length).toBeGreaterThanOrEqual(1);

                // Should NOT report any bugs (these are expected UI changes, not bugs)
                expect(result.bugReports).toHaveLength(0);
            },
        );
    });

    describe("auth flow - validation bug, login skill outdated", () => {
        it(
            "should report a bug for signup and update the login skill",
            { repeats: EVAL_REPEATS, timeout: AGENT_TIMEOUT },
            async () => {
                fixture = await createAuthFlowFixture();
                const callbacks = buildMockCallbacks(fixture.testRunResults);
                const { model, registry } = createEvalModel();

                const agent = new DiffsAgent({
                    model,
                    workingDirectory: fixture.repoDir,
                    callbacks,
                    maxSteps: 40,
                });

                const result = await agent.analyze(fixture.input);

                console.log("=== Auth Flow Results ===");
                console.log("Reasoning:", result.reasoning);
                console.log("Test actions:", JSON.stringify(result.testActions, null, 2));
                console.log("Bug reports:", JSON.stringify(result.bugReports, null, 2));
                console.log("Skill updates:", JSON.stringify(result.skillUpdates, null, 2));
                console.log("New tests:", JSON.stringify(result.newTests, null, 2));
                console.log("Model usage:", JSON.stringify(registry.modelUsage, null, 2));

                // Should run the signup test (it fails due to validation bug)
                expect(callbacks.calls.triggerTestsAndWait).toContain("test-signup");

                // Signup test failed due to a bug in the email validation regex - should report bug
                const signupBug = result.bugReports.find((b) => b.slug === "test-signup");
                expect(signupBug).toBeDefined();
                expect(signupBug?.fixPrompt).toBeTruthy();
                expect(signupBug?.detailedExplanation).toBeTruthy();

                // Login skill should be updated (new "Remember me" checkbox)
                expect(result.skillUpdates.length).toBeGreaterThanOrEqual(1);
                const loginSkillUpdate = result.skillUpdates.find((s) => s.skillId === "skill-login");
                expect(loginSkillUpdate).toBeDefined();

                // Login test passes - should NOT have any action for it
                const loginActions = result.testActions.filter((a) => a.slug === "test-login");
                expect(loginActions).toHaveLength(0);
            },
        );
    });

    describe("form project (v0) - multi-step wizard, validation bug, social media section", () => {
        it(
            "should modify tests for wizard flow, report phone validation bug, update fill-form skill, and add social media tests",
            { repeats: EVAL_REPEATS, timeout: AGENT_TIMEOUT },
            async () => {
                fixture = await createFormProjectFixture();
                const callbacks = buildMockCallbacks(fixture.testRunResults);
                const { model, registry } = createEvalModel();

                const agent = new DiffsAgent({
                    model,
                    workingDirectory: fixture.repoDir,
                    callbacks,
                    maxSteps: 50,
                });

                const result = await agent.analyze(fixture.input);

                console.log("=== Form Project Results ===");
                console.log("Reasoning:", result.reasoning);
                console.log("Test actions:", JSON.stringify(result.testActions, null, 2));
                console.log("Bug reports:", JSON.stringify(result.bugReports, null, 2));
                console.log("Skill updates:", JSON.stringify(result.skillUpdates, null, 2));
                console.log("New tests:", JSON.stringify(result.newTests, null, 2));
                console.log("Model usage:", JSON.stringify(registry.modelUsage, null, 2));

                // Should have run the failing tests (at minimum the ones affected by changes)
                const ranTests = callbacks.calls.triggerTestsAndWait as string[];
                expect(ranTests.length).toBeGreaterThanOrEqual(3);

                // Phone validation bug: the phone regex requires country code prefix,
                // rejecting valid local formats. Agent should find this is a code bug.
                expect(result.bugReports.length).toBeGreaterThanOrEqual(1);
                const phoneBug = result.bugReports.find((b) => b.affectedFiles.includes("lib/validation.ts"));
                expect(phoneBug).toBeDefined();
                expect(phoneBug?.fixPrompt).toBeTruthy();

                // Tests that failed due to UI restructure should be modified, not quarantined
                const modifyActions = result.testActions.filter((a) => a.type === "modify");
                expect(modifyActions.length).toBeGreaterThanOrEqual(2);

                // "Go Back & Edit" button was removed - test should be modified
                const hasGoBackModify = modifyActions.some((a) => a.slug === "test-go-back-edit");
                expect(hasGoBackModify).toBe(true);

                // LinkedIn moved to Social step - test should be modified
                const hasLinkedInModify = modifyActions.some((a) => a.slug === "test-linkedin-url");
                expect(hasLinkedInModify).toBe(true);

                // Skills should be updated (fill-complete-form, review-and-submit, go-back-and-edit all outdated)
                expect(result.skillUpdates.length).toBeGreaterThanOrEqual(2);
                const fillFormSkill = result.skillUpdates.find((s) => s.skillId === "skill-fill-complete-form");
                expect(fillFormSkill).toBeDefined();

                // Should suggest new tests for social media section and/or step validation
                expect(result.newTests.length).toBeGreaterThanOrEqual(1);

                // Should NOT quarantine any tests (all flows still exist, just restructured)
                const quarantineActions = result.testActions.filter((a) => a.type === "quarantine");
                expect(quarantineActions).toHaveLength(0);

                // test-required-only passed - should NOT be quarantined or flagged as bug
                const requiredOnlyBugs = result.bugReports.filter((b) => b.slug === "test-required-only");
                expect(requiredOnlyBugs).toHaveLength(0);
                const requiredOnlyQuarantine = result.testActions.filter(
                    (a) => a.slug === "test-required-only" && a.type === "quarantine",
                );
                expect(requiredOnlyQuarantine).toHaveLength(0);
            },
        );
    });

    describe("ecommerce - carousel to grid, discount bug, Buy Now", () => {
        it(
            "should modify carousel tests, report discount bug, update browse-images skill, and add Buy Now test",
            { repeats: EVAL_REPEATS, timeout: AGENT_TIMEOUT },
            async () => {
                fixture = await createEcommerceFixture();
                const callbacks = buildMockCallbacks(fixture.testRunResults);
                const { model, registry } = createEvalModel();

                const agent = new DiffsAgent({
                    model,
                    workingDirectory: fixture.repoDir,
                    callbacks,
                    maxSteps: 40,
                });

                const result = await agent.analyze(fixture.input);

                console.log("=== Ecommerce Results ===");
                console.log("Reasoning:", result.reasoning);
                console.log("Test actions:", JSON.stringify(result.testActions, null, 2));
                console.log("Bug reports:", JSON.stringify(result.bugReports, null, 2));
                console.log("Skill updates:", JSON.stringify(result.skillUpdates, null, 2));
                console.log("New tests:", JSON.stringify(result.newTests, null, 2));
                console.log("Model usage:", JSON.stringify(registry.modelUsage, null, 2));

                // Should have run the failing tests
                expect(callbacks.calls.triggerTestsAndWait).toContain("test-browse-images");
                expect(callbacks.calls.triggerTestsAndWait).toContain("test-price-display");

                // Browse-images test failed because carousel was replaced with grid - should be modified
                const modifyActions = result.testActions.filter((a) => a.type === "modify");
                const hasBrowseModify = modifyActions.some((a) => a.slug === "test-browse-images");
                expect(hasBrowseModify).toBe(true);

                // Price display test failed due to double discount bug - should report bug
                const priceBug = result.bugReports.find((b) => b.slug === "test-price-display");
                expect(priceBug).toBeDefined();
                expect(priceBug?.fixPrompt).toBeTruthy();

                // Browse images skill should be updated (carousel instructions outdated)
                const browseSkillUpdate = result.skillUpdates.find((s) => s.skillId === "skill-browse-images");
                expect(browseSkillUpdate).toBeDefined();

                // Should suggest at least one new test for Buy Now feature
                expect(result.newTests.length).toBeGreaterThanOrEqual(1);
            },
        );
    });

    describe("kanban - drag-and-drop, off-by-one bug, delete column", () => {
        it(
            "should modify move tests, report off-by-one bug, update move-task skill, and add delete column test",
            { repeats: EVAL_REPEATS, timeout: 600_000 },
            async () => {
                fixture = await createKanbanFixture();
                const callbacks = buildMockCallbacks(fixture.testRunResults);
                const { model, registry } = createEvalModel();

                const agent = new DiffsAgent({
                    model,
                    workingDirectory: fixture.repoDir,
                    callbacks,
                    maxSteps: 40,
                });

                const result = await agent.analyze(fixture.input);

                console.log("=== Kanban Results ===");
                console.log("Reasoning:", result.reasoning);
                console.log("Test actions:", JSON.stringify(result.testActions, null, 2));
                console.log("Bug reports:", JSON.stringify(result.bugReports, null, 2));
                console.log("Skill updates:", JSON.stringify(result.skillUpdates, null, 2));
                console.log("New tests:", JSON.stringify(result.newTests, null, 2));
                console.log("Model usage:", JSON.stringify(registry.modelUsage, null, 2));

                // Should have run the failing tests
                expect(callbacks.calls.triggerTestsAndWait).toContain("test-move-right");
                expect(callbacks.calls.triggerTestsAndWait).toContain("test-move-left");
                expect(callbacks.calls.triggerTestsAndWait).toContain("test-move-journey");

                // Move tests failed because buttons replaced with drag-and-drop - should be modified
                const modifyActions = result.testActions.filter((a) => a.type === "modify");
                const hasMoveRightModify = modifyActions.some((a) => a.slug === "test-move-right");
                const hasMoveLeftModify = modifyActions.some((a) => a.slug === "test-move-left");
                expect(hasMoveRightModify).toBe(true);
                expect(hasMoveLeftModify).toBe(true);

                // Move-journey test exposed the off-by-one bug in drop handler - should report bug
                const journeyBug = result.bugReports.find((b) => b.slug === "test-move-journey");
                expect(journeyBug).toBeDefined();
                expect(journeyBug?.fixPrompt).toBeTruthy();

                // Move-task skill should be updated (references move buttons)
                const moveSkillUpdate = result.skillUpdates.find((s) => s.skillId === "skill-move-task");
                expect(moveSkillUpdate).toBeDefined();

                // Should suggest at least one new test for delete column
                expect(result.newTests.length).toBeGreaterThanOrEqual(1);
            },
        );
    });

    describe("chat - read receipts removed, typing indicator bug, reactions added", () => {
        it(
            "should quarantine read-receipt tests, report typing bug, modify styling test, and add reactions test",
            { repeats: EVAL_REPEATS, timeout: AGENT_TIMEOUT },
            async () => {
                fixture = await createChatFixture();
                const callbacks = buildMockCallbacks(fixture.testRunResults);
                const { model, registry } = createEvalModel();

                const agent = new DiffsAgent({
                    model,
                    workingDirectory: fixture.repoDir,
                    callbacks,
                    maxSteps: 40,
                });

                const result = await agent.analyze(fixture.input);

                console.log("=== Chat Results ===");
                console.log("Reasoning:", result.reasoning);
                console.log("Test actions:", JSON.stringify(result.testActions, null, 2));
                console.log("Bug reports:", JSON.stringify(result.bugReports, null, 2));
                console.log("Skill updates:", JSON.stringify(result.skillUpdates, null, 2));
                console.log("New tests:", JSON.stringify(result.newTests, null, 2));
                console.log("Model usage:", JSON.stringify(registry.modelUsage, null, 2));

                // Read receipt tests should be quarantined (feature removed entirely)
                const quarantineActions = result.testActions.filter((a) => a.type === "quarantine");
                const hasReadReceiptQuarantine = quarantineActions.some((a) => a.slug === "test-read-receipt");
                const hasSeenTransitionQuarantine = quarantineActions.some((a) => a.slug === "test-seen-transition");
                expect(hasReadReceiptQuarantine).toBe(true);
                expect(hasSeenTransitionQuarantine).toBe(true);

                // Message styling test should be modified (check icons removed)
                const modifyActions = result.testActions.filter((a) => a.type === "modify");
                const hasStylingModify = modifyActions.some((a) => a.slug === "test-message-styling");
                expect(hasStylingModify).toBe(true);

                // Typing indicator has a bug (persists across conversation switches)
                const typingBug = result.bugReports.find((b) => b.slug === "test-typing-indicator");
                expect(typingBug).toBeDefined();
                expect(typingBug?.fixPrompt).toBeTruthy();

                // Send-message skill should be updated (references seen status)
                const sendSkillUpdate = result.skillUpdates.find((s) => s.skillId === "skill-send-message");
                expect(sendSkillUpdate).toBeDefined();

                // Should suggest at least one new test for reactions
                expect(result.newTests.length).toBeGreaterThanOrEqual(1);
            },
        );
    });

    describe("data-table - pagination to infinite scroll, sort indicator bug, column visibility", () => {
        it(
            "should quarantine pagination-navigation, modify search-pagination-reset, report sort bug, and add column visibility test",
            { repeats: EVAL_REPEATS, timeout: AGENT_TIMEOUT },
            async () => {
                fixture = await createDataTableFixture();
                const callbacks = buildMockCallbacks(fixture.testRunResults);
                const { model, registry } = createEvalModel();

                const agent = new DiffsAgent({
                    model,
                    workingDirectory: fixture.repoDir,
                    callbacks,
                    maxSteps: 40,
                });

                const result = await agent.analyze(fixture.input);

                console.log("=== Data Table Results ===");
                console.log("Reasoning:", result.reasoning);
                console.log("Test actions:", JSON.stringify(result.testActions, null, 2));
                console.log("Bug reports:", JSON.stringify(result.bugReports, null, 2));
                console.log("Skill updates:", JSON.stringify(result.skillUpdates, null, 2));
                console.log("New tests:", JSON.stringify(result.newTests, null, 2));
                console.log("Model usage:", JSON.stringify(registry.modelUsage, null, 2));

                // Both pagination tests should be MODIFIED (the underlying flows still exist in infinite scroll)
                const modifyActions = result.testActions.filter((a) => a.type === "modify");
                const hasPaginationModify = modifyActions.some((a) => a.slug === "test-pagination-navigation");
                const hasSearchPaginationModify = modifyActions.some((a) => a.slug === "test-search-pagination-reset");
                expect(hasPaginationModify).toBe(true);
                expect(hasSearchPaginationModify).toBe(true);

                // Should NOT quarantine - these flows still exist via infinite scroll
                const quarantineActions = result.testActions.filter((a) => a.type === "quarantine");
                expect(quarantineActions).toHaveLength(0);

                // Sort ascending test exposed the inverted icon bug - should report bug
                expect(callbacks.calls.triggerTestsAndWait).toContain("test-sort-ascending");
                const sortBug = result.bugReports.find((b) => b.slug === "test-sort-ascending");
                expect(sortBug).toBeDefined();
                expect(sortBug?.fixPrompt).toBeTruthy();

                // Results count test should be modified ("Showing" -> "Loaded")
                const hasResultsModify = modifyActions.some((a) => a.slug === "test-results-count");
                expect(hasResultsModify).toBe(true);

                // Navigate-pages skill should be updated (pagination no longer exists)
                const navSkillUpdate = result.skillUpdates.find((s) => s.skillId === "skill-navigate-pages");
                expect(navSkillUpdate).toBeDefined();

                // Should suggest new tests for column visibility and/or infinite scroll
                expect(result.newTests.length).toBeGreaterThanOrEqual(1);
            },
        );
    });

    describe("checkout - coupon codes, PayPal, division-by-zero bug", () => {
        it(
            "should modify payment tests, report division-by-zero bug, update payment skill, and add coupon/PayPal tests",
            { repeats: EVAL_REPEATS, timeout: AGENT_TIMEOUT },
            async () => {
                fixture = await createCheckoutFixture();
                const callbacks = buildMockCallbacks(fixture.testRunResults);
                const { model, registry } = createEvalModel();

                const agent = new DiffsAgent({
                    model,
                    workingDirectory: fixture.repoDir,
                    callbacks,
                    maxSteps: 40,
                });

                const result = await agent.analyze(fixture.input);

                console.log("=== Checkout Results ===");
                console.log("Reasoning:", result.reasoning);
                console.log("Test actions:", JSON.stringify(result.testActions, null, 2));
                console.log("Bug reports:", JSON.stringify(result.bugReports, null, 2));
                console.log("Skill updates:", JSON.stringify(result.skillUpdates, null, 2));
                console.log("New tests:", JSON.stringify(result.newTests, null, 2));
                console.log("Model usage:", JSON.stringify(registry.modelUsage, null, 2));

                // Happy path and payment validation tests should be modified (payment form has tabs now)
                const modifyActions = result.testActions.filter((a) => a.type === "modify");
                const hasHappyPathModify = modifyActions.some((a) => a.slug === "test-happy-path");
                const hasPaymentModify = modifyActions.some((a) => a.slug === "test-payment-validation");
                expect(hasHappyPathModify).toBe(true);
                expect(hasPaymentModify).toBe(true);

                // Coupon-100 test exposed division-by-zero bug - should report bug
                expect(callbacks.calls.triggerTestsAndWait).toContain("test-coupon-100");
                const couponBug = result.bugReports.find((b) => b.slug === "test-coupon-100");
                expect(couponBug).toBeDefined();
                expect(couponBug?.fixPrompt).toBeTruthy();

                // Payment skill should be updated (tabs added)
                const paymentSkillUpdate = result.skillUpdates.find((s) => s.skillId === "skill-fill-payment");
                expect(paymentSkillUpdate).toBeDefined();

                // Should suggest new tests for coupon and/or PayPal features
                expect(result.newTests.length).toBeGreaterThanOrEqual(1);

                // Should NOT quarantine any tests (all flows still exist)
                const quarantineActions = result.testActions.filter((a) => a.type === "quarantine");
                expect(quarantineActions).toHaveLength(0);
            },
        );
    });

    describe("settings page - UI restructured into tabs", () => {
        it(
            "should modify both tests (not report bugs) since the functionality is the same",
            { repeats: EVAL_REPEATS, timeout: AGENT_TIMEOUT },
            async () => {
                fixture = await createSettingsPageFixture();
                const callbacks = buildMockCallbacks(fixture.testRunResults);
                const { model, registry } = createEvalModel();

                const agent = new DiffsAgent({
                    model,
                    workingDirectory: fixture.repoDir,
                    callbacks,
                    maxSteps: 40,
                });

                const result = await agent.analyze(fixture.input);

                console.log("=== Settings Page Results ===");
                console.log("Reasoning:", result.reasoning);
                console.log("Test actions:", JSON.stringify(result.testActions, null, 2));
                console.log("Bug reports:", JSON.stringify(result.bugReports, null, 2));
                console.log("New tests:", JSON.stringify(result.newTests, null, 2));
                console.log("Model usage:", JSON.stringify(registry.modelUsage, null, 2));

                // Should have run both tests
                expect(callbacks.calls.triggerTestsAndWait).toContain("test-update-profile");
                expect(callbacks.calls.triggerTestsAndWait).toContain("test-toggle-notifications");

                // Both tests failed because the UI changed - should be modified, NOT flagged as bugs
                const modifyActions = result.testActions.filter((a) => a.type === "modify");
                expect(modifyActions.length).toBeGreaterThanOrEqual(2);

                const hasProfileModify = modifyActions.some((a) => a.slug === "test-update-profile");
                const hasNotificationsModify = modifyActions.some((a) => a.slug === "test-toggle-notifications");
                expect(hasProfileModify).toBe(true);
                expect(hasNotificationsModify).toBe(true);

                // Should NOT report any bugs - this is a UI restructure, not a bug
                expect(result.bugReports).toHaveLength(0);

                // Should NOT quarantine - the functionality still exists, just in tabs now
                const quarantineActions = result.testActions.filter((a) => a.type === "quarantine");
                expect(quarantineActions).toHaveLength(0);
            },
        );
    });
});
