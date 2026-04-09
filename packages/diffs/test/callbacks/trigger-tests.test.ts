import type { BillingService } from "@autonoma/billing";
import { expect, vi } from "vitest";
import type { TriggerRunWorkflowFn, TriggerTestsParams } from "../../src/callbacks/trigger-tests";
import { triggerTestsAndWait } from "../../src/callbacks/trigger-tests";
import type { DiffsCallbackHarness } from "./harness";
import { diffsCallbackSuite } from "./harness";

function createMockBillingService(overrides?: Partial<BillingService>): BillingService {
    return {
        getOrCreateCustomer: vi.fn(),
        createCheckoutSession: vi.fn(),
        createPortalSession: vi.fn(),
        getBillingStatus: vi.fn(),
        updateAutoTopUp: vi.fn(),
        checkCreditsGate: vi.fn(),
        deductCreditsForGeneration: vi.fn(),
        deductCreditsForRun: vi.fn().mockResolvedValue(true),
        refundCreditsForGeneration: vi.fn(),
        redeemPromoCode: vi.fn(),
        listPromoCodes: vi.fn(),
        ...overrides,
    } as BillingService;
}

function buildParams(
    harness: DiffsCallbackHarness,
    organizationId: string,
    applicationId: string,
    overrides?: Partial<TriggerTestsParams>,
): TriggerTestsParams {
    return {
        db: harness.db,
        applicationId,
        organizationId,
        agentVersion: "test-v1",
        billingService: createMockBillingService(),
        triggerRunWorkflow: vi.fn(),
        ...overrides,
    };
}

// Tests that trigger runs need a poll cycle (5s) to detect completion
const POLLING_TIMEOUT = 15_000;

diffsCallbackSuite({
    name: "triggerTestsAndWait",
    cases: (test) => {
        test("returns error result for unknown slug", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const results = await triggerTestsAndWait(
                ["nonexistent-slug"],
                buildParams(harness, organizationId, applicationId),
            );

            expect(results).toHaveLength(1);
            expect(results[0]!.slug).toBe("nonexistent-slug");
            expect(results[0]!.success).toBe(false);
            expect(results[0]!.finishReason).toBe("error");
            expect(results[0]!.reasoning).toContain("Test case not found");
        });

        test("returns error result when test has no runnable assignment", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            await harness.setupBranchWithTest(organizationId, applicationId, "no-steps-test", "No Steps Test");

            const results = await triggerTestsAndWait(
                ["no-steps-test"],
                buildParams(harness, organizationId, applicationId),
            );

            expect(results).toHaveLength(1);
            expect(results[0]!.slug).toBe("no-steps-test");
            expect(results[0]!.success).toBe(false);
            expect(results[0]!.reasoning).toContain("No runnable assignment");
        });

        test("returns error results when billing check fails", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            await harness.setupRunnableTest(organizationId, applicationId, "billing-test", "Billing Test");

            const results = await triggerTestsAndWait(
                ["billing-test"],
                buildParams(harness, organizationId, applicationId, {
                    billingService: createMockBillingService({
                        checkCreditsGate: vi.fn().mockRejectedValue(new Error("Insufficient credits")),
                    }),
                }),
            );

            expect(results).toHaveLength(1);
            expect(results[0]!.slug).toBe("billing-test");
            expect(results[0]!.success).toBe(false);
            expect(results[0]!.reasoning).toContain("Insufficient billing credits");
        });

        test("returns error for run when workflow trigger fails", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            await harness.setupRunnableTest(organizationId, applicationId, "wf-fail-test", "WF Fail Test");

            const triggerRunWorkflow: TriggerRunWorkflowFn = vi.fn().mockRejectedValue(new Error("Argo unreachable"));

            const results = await triggerTestsAndWait(
                ["wf-fail-test"],
                buildParams(harness, organizationId, applicationId, { triggerRunWorkflow }),
            );

            expect(results).toHaveLength(1);
            expect(results[0]!.slug).toBe("wf-fail-test");
            expect(results[0]!.success).toBe(false);
            expect(results[0]!.reasoning).toContain("Failed to trigger test execution workflow");

            // Verify run was marked as failed in DB with reasoning
            const run = await harness.db.run.findFirstOrThrow({
                where: {
                    assignment: { testCase: { slug: "wf-fail-test" } },
                },
                select: { status: true, reasoning: true },
            });
            expect(run.status).toBe("failed");
            expect(run.reasoning).toContain("Workflow trigger failed");
        });

        test(
            "creates run records, triggers workflow, and returns successful results",
            async ({ harness, seedResult: { organizationId, applicationId } }) => {
                await harness.setupRunnableTest(organizationId, applicationId, "success-test", "Success Test");

                const triggerRunWorkflow: TriggerRunWorkflowFn = vi.fn().mockImplementation(async (params) => {
                    await harness.db.run.update({
                        where: { id: params.runId },
                        data: { status: "success", reasoning: "All assertions passed" },
                    });
                });

                const results = await triggerTestsAndWait(
                    ["success-test"],
                    buildParams(harness, organizationId, applicationId, { triggerRunWorkflow }),
                );

                expect(results).toHaveLength(1);
                expect(results[0]!.slug).toBe("success-test");
                expect(results[0]!.success).toBe(true);
                expect(results[0]!.finishReason).toBe("success");
                expect(results[0]!.reasoning).toBe("All assertions passed");
            },
            POLLING_TIMEOUT,
        );

        test(
            "handles mixed batch with successful and failed runs",
            async ({ harness, seedResult: { organizationId, applicationId } }) => {
                await harness.setupRunnableTest(organizationId, applicationId, "batch-pass", "Batch Pass");
                await harness.setupRunnableTest(organizationId, applicationId, "batch-fail", "Batch Fail");

                const triggerRunWorkflow: TriggerRunWorkflowFn = vi.fn().mockImplementation(async (params) => {
                    const run = await harness.db.run.findUniqueOrThrow({
                        where: { id: params.runId },
                        select: { assignment: { select: { testCase: { select: { slug: true } } } } },
                    });

                    const slug = run.assignment.testCase.slug;
                    await harness.db.run.update({
                        where: { id: params.runId },
                        data: {
                            status: slug === "batch-pass" ? "success" : "failed",
                            reasoning: slug === "batch-pass" ? "Passed" : "Element not found",
                        },
                    });
                });

                const results = await triggerTestsAndWait(
                    ["batch-pass", "batch-fail"],
                    buildParams(harness, organizationId, applicationId, { triggerRunWorkflow }),
                );

                expect(results).toHaveLength(2);

                const passResult = results.find((r) => r.slug === "batch-pass");
                const failResult = results.find((r) => r.slug === "batch-fail");

                expect(passResult!.success).toBe(true);
                expect(passResult!.reasoning).toBe("Passed");
                expect(failResult!.success).toBe(false);
                expect(failResult!.reasoning).toBe("Element not found");
            },
            POLLING_TIMEOUT,
        );

        test(
            "maps step outputs and screenshots in results",
            async ({ harness, seedResult: { organizationId, applicationId } }) => {
                const { assignmentId } = await harness.setupRunnableTest(
                    organizationId,
                    applicationId,
                    "steps-test",
                    "Steps Test",
                );

                const assignment = await harness.db.testCaseAssignment.findUniqueOrThrow({
                    where: { id: assignmentId },
                    select: { stepsId: true },
                });

                const stepInput = await harness.db.stepInput.findFirstOrThrow({
                    where: { listId: assignment.stepsId! },
                });

                const triggerRunWorkflow: TriggerRunWorkflowFn = vi.fn().mockImplementation(async (params) => {
                    await harness.db.stepOutputList.create({
                        data: {
                            runId: params.runId,
                            organizationId,
                            list: {
                                create: [
                                    {
                                        order: 0,
                                        output: { outcome: "Clicked login button" },
                                        stepInputId: stepInput.id,
                                        screenshotAfter: "https://screenshots.test/step-0.png",
                                        organizationId,
                                    },
                                    {
                                        order: 1,
                                        output: { outcome: "Entered credentials" },
                                        stepInputId: stepInput.id,
                                        screenshotAfter: "https://screenshots.test/step-1.png",
                                        organizationId,
                                    },
                                ],
                            },
                        },
                    });

                    await harness.db.run.update({
                        where: { id: params.runId },
                        data: { status: "success", reasoning: "All steps passed" },
                    });
                });

                const results = await triggerTestsAndWait(
                    ["steps-test"],
                    buildParams(harness, organizationId, applicationId, { triggerRunWorkflow }),
                );

                expect(results).toHaveLength(1);
                expect(results[0]!.stepDescriptions).toEqual(["Clicked login button", "Entered credentials"]);
                expect(results[0]!.screenshotUrls).toEqual([
                    "https://screenshots.test/step-0.png",
                    "https://screenshots.test/step-1.png",
                ]);
            },
            POLLING_TIMEOUT,
        );

        test(
            "includes early failures alongside successful results in mixed batch",
            async ({ harness, seedResult: { organizationId, applicationId } }) => {
                await harness.setupRunnableTest(organizationId, applicationId, "exists-test", "Exists Test");

                const triggerRunWorkflow: TriggerRunWorkflowFn = vi.fn().mockImplementation(async (params) => {
                    await harness.db.run.update({
                        where: { id: params.runId },
                        data: { status: "success", reasoning: "Passed" },
                    });
                });

                const results = await triggerTestsAndWait(
                    ["nonexistent-slug", "exists-test"],
                    buildParams(harness, organizationId, applicationId, { triggerRunWorkflow }),
                );

                expect(results).toHaveLength(2);

                const notFoundResult = results.find((r) => r.slug === "nonexistent-slug");
                expect(notFoundResult!.success).toBe(false);
                expect(notFoundResult!.reasoning).toContain("Test case not found");

                const successResult = results.find((r) => r.slug === "exists-test");
                expect(successResult!.success).toBe(true);
            },
            POLLING_TIMEOUT,
        );

        test("marks run as failed when deductCreditsForRun throws", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            await harness.setupRunnableTest(organizationId, applicationId, "deduct-fail", "Deduct Fail");

            const billingService = createMockBillingService({
                deductCreditsForRun: vi.fn().mockRejectedValue(new Error("Payment failed")),
            });

            const results = await triggerTestsAndWait(
                ["deduct-fail"],
                buildParams(harness, organizationId, applicationId, { billingService }),
            );

            expect(results).toHaveLength(1);
            expect(results[0]!.success).toBe(false);
            expect(results[0]!.reasoning).toContain("Failed to deduct billing credits");

            // Verify run was marked as failed in DB
            const run = await harness.db.run.findFirstOrThrow({
                where: {
                    assignment: { testCase: { slug: "deduct-fail" } },
                },
                select: { status: true },
            });
            expect(run.status).toBe("failed");
        });
    },
});
