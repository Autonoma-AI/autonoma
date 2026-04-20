import type { BillingService } from "@autonoma/billing";
import { expect, vi } from "vitest";
import type { PrepareRunsParams } from "../../src/callbacks/trigger-tests";
import { prepareRuns } from "../../src/callbacks/trigger-tests";
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
    snapshotId: string,
    overrides?: Partial<PrepareRunsParams>,
): PrepareRunsParams {
    return {
        db: harness.db,
        snapshotId,
        applicationId,
        organizationId,
        billingService: createMockBillingService(),
        ...overrides,
    };
}

diffsCallbackSuite({
    name: "prepareRuns",
    cases: (test) => {
        test("returns empty array for unknown slug", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const { snapshotId } = await harness.setupBranchWithTest(
                organizationId,
                applicationId,
                "placeholder",
                "Placeholder",
            );

            const results = await prepareRuns(
                ["nonexistent-slug"],
                buildParams(harness, organizationId, applicationId, snapshotId),
            );

            expect(results).toHaveLength(0);
        });

        test("returns empty array when test has no runnable assignment", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const { snapshotId } = await harness.setupBranchWithTest(
                organizationId,
                applicationId,
                "no-steps-test",
                "No Steps Test",
            );

            const results = await prepareRuns(
                ["no-steps-test"],
                buildParams(harness, organizationId, applicationId, snapshotId),
            );

            expect(results).toHaveLength(0);
        });

        test("returns empty array when billing check fails", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const { snapshotId } = await harness.setupRunnableTest(
                organizationId,
                applicationId,
                "billing-test",
                "Billing Test",
            );

            const results = await prepareRuns(
                ["billing-test"],
                buildParams(harness, organizationId, applicationId, snapshotId, {
                    billingService: createMockBillingService({
                        checkCreditsGate: vi.fn().mockRejectedValue(new Error("Insufficient credits")),
                    }),
                }),
            );

            expect(results).toHaveLength(0);
        });

        test("creates run records and returns prepared results", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const { snapshotId } = await harness.setupRunnableTest(
                organizationId,
                applicationId,
                "success-test",
                "Success Test",
            );

            const results = await prepareRuns(
                ["success-test"],
                buildParams(harness, organizationId, applicationId, snapshotId),
            );

            expect(results).toHaveLength(1);
            expect(results[0]!.slug).toBe("success-test");
            expect(results[0]!.runId).toBeDefined();
            expect(results[0]!.architecture).toBe("WEB");

            // Verify run record exists in DB with pending status
            const run = await harness.db.run.findUniqueOrThrow({
                where: { id: results[0]!.runId },
                select: { status: true },
            });
            expect(run.status).toBe("pending");
        });

        test("handles mixed batch with known and unknown slugs", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const { snapshotId } = await harness.setupRunnableTest(
                organizationId,
                applicationId,
                "exists-test",
                "Exists Test",
            );

            const results = await prepareRuns(
                ["nonexistent-slug", "exists-test"],
                buildParams(harness, organizationId, applicationId, snapshotId),
            );

            // Only the known slug with a runnable assignment gets a run
            expect(results).toHaveLength(1);
            expect(results[0]!.slug).toBe("exists-test");
        });

        test("marks run as failed when deductCreditsForRun throws", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const { snapshotId } = await harness.setupRunnableTest(
                organizationId,
                applicationId,
                "deduct-fail",
                "Deduct Fail",
            );

            const billingService = createMockBillingService({
                deductCreditsForRun: vi.fn().mockRejectedValue(new Error("Payment failed")),
            });

            const results = await prepareRuns(
                ["deduct-fail"],
                buildParams(harness, organizationId, applicationId, snapshotId, { billingService }),
            );

            // Run was created but deduction failed, so it's not in results
            expect(results).toHaveLength(0);

            // Verify run was marked as failed in DB
            const run = await harness.db.run.findFirstOrThrow({
                where: {
                    assignment: { testCase: { slug: "deduct-fail" } },
                },
                select: { status: true },
            });
            expect(run.status).toBe("failed");
        });

        test("skips test case with assignment from a different snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            // Set up a runnable test in snapshot A
            const { snapshotId: snapshotA } = await harness.setupRunnableTest(
                organizationId,
                applicationId,
                "cross-snapshot-test",
                "Cross Snapshot Test",
            );

            // Create a fresh branch with a different snapshot (no assignment for cross-snapshot-test)
            const { snapshotId: snapshotB } = await harness.setupBranchWithTest(
                organizationId,
                applicationId,
                "other-placeholder",
                "Other Placeholder",
            );

            // Request the test from snapshot A against snapshot B: no assignment exists in B
            const results = await prepareRuns(
                ["cross-snapshot-test"],
                buildParams(harness, organizationId, applicationId, snapshotB),
            );

            expect(results).toHaveLength(0);

            // Sanity check: using snapshot A, the test is runnable
            const resultsA = await prepareRuns(
                ["cross-snapshot-test"],
                buildParams(harness, organizationId, applicationId, snapshotA),
            );
            expect(resultsA).toHaveLength(1);
        });
    },
});
