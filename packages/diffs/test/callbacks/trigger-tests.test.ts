import type { BillingService } from "@autonoma/billing";
import { expect, vi } from "vitest";
import type { AffectedTestSpec, PrepareAffectedTestsParams } from "../../src/callbacks/trigger-tests";
import { prepareAffectedTestGenerations } from "../../src/callbacks/trigger-tests";
import type { DiffsCallbackHarness } from "./harness";
import { diffsCallbackSuite } from "./harness";

function specs(...slugs: string[]): AffectedTestSpec[] {
    return slugs.map((slug) => ({ slug, affectedReason: "code_change", reasoning: "test reasoning" }));
}

function createMockBillingService(overrides?: Partial<BillingService>): BillingService {
    return {
        getOrCreateCustomer: vi.fn(),
        createCheckoutSession: vi.fn(),
        createPortalSession: vi.fn(),
        getBillingStatus: vi.fn(),
        updateAutoTopUp: vi.fn(),
        checkCreditsGate: vi.fn(),
        deductCreditsForGeneration: vi.fn().mockResolvedValue(true),
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
    overrides?: Partial<PrepareAffectedTestsParams>,
): PrepareAffectedTestsParams {
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
    name: "prepareAffectedTestGenerations",
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

            const results = await prepareAffectedTestGenerations(
                specs("nonexistent-slug"),
                buildParams(harness, organizationId, applicationId, snapshotId),
            );

            expect(results).toHaveLength(0);
        });

        test("returns empty array when billing check fails", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const { snapshotId } = await harness.setupBranchWithTest(
                organizationId,
                applicationId,
                "billing-test",
                "Billing Test",
            );

            const results = await prepareAffectedTestGenerations(
                specs("billing-test"),
                buildParams(harness, organizationId, applicationId, snapshotId, {
                    billingService: createMockBillingService({
                        checkCreditsGate: vi.fn().mockRejectedValue(new Error("Insufficient credits")),
                    }),
                }),
            );

            expect(results).toHaveLength(0);
        });

        test("creates pending generation records and returns prepared results", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const { snapshotId, testCaseId } = await harness.setupBranchWithTest(
                organizationId,
                applicationId,
                "success-test",
                "Success Test",
            );

            const results = await prepareAffectedTestGenerations(
                specs("success-test"),
                buildParams(harness, organizationId, applicationId, snapshotId),
            );

            expect(results).toHaveLength(1);
            expect(results[0]!.slug).toBe("success-test");
            expect(results[0]!.generationId).toBeDefined();
            expect(results[0]!.architecture).toBe("WEB");

            // The generation exists in DB, pending, on the target snapshot.
            const generation = await harness.db.testGeneration.findUniqueOrThrow({
                where: { id: results[0]!.generationId },
                select: { status: true, snapshotId: true },
            });
            expect(generation.status).toBe("pending");
            expect(generation.snapshotId).toBe(snapshotId);

            // The AffectedTest row links the generation (not a run).
            const affected = await harness.db.affectedTest.findUniqueOrThrow({
                where: { snapshotId_testCaseId: { snapshotId, testCaseId } },
                select: { generationId: true, runId: true },
            });
            expect(affected.generationId).toBe(results[0]!.generationId);
            expect(affected.runId).toBeNull();
        });

        test("handles mixed batch with known and unknown slugs", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const { snapshotId } = await harness.setupBranchWithTest(
                organizationId,
                applicationId,
                "exists-test",
                "Exists Test",
            );

            const results = await prepareAffectedTestGenerations(
                specs("nonexistent-slug", "exists-test"),
                buildParams(harness, organizationId, applicationId, snapshotId),
            );

            // Only the known slug with a plan-linked assignment gets a generation.
            expect(results).toHaveLength(1);
            expect(results[0]!.slug).toBe("exists-test");
        });

        test("marks generation as failed when deductCreditsForGeneration throws", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const { snapshotId } = await harness.setupBranchWithTest(
                organizationId,
                applicationId,
                "deduct-fail",
                "Deduct Fail",
            );

            const billingService = createMockBillingService({
                deductCreditsForGeneration: vi.fn().mockRejectedValue(new Error("Payment failed")),
            });

            const results = await prepareAffectedTestGenerations(
                specs("deduct-fail"),
                buildParams(harness, organizationId, applicationId, snapshotId, { billingService }),
            );

            // Generation was created but deduction failed, so it's not in results.
            expect(results).toHaveLength(0);

            // Verify a generation was marked as failed in DB.
            const generation = await harness.db.testGeneration.findFirstOrThrow({
                where: { testPlan: { testCase: { slug: "deduct-fail" } }, status: "failed" },
                select: { status: true },
            });
            expect(generation.status).toBe("failed");
        });

        test("skips test case with assignment from a different snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            // Set up a test in snapshot A.
            const { snapshotId: snapshotA } = await harness.setupBranchWithTest(
                organizationId,
                applicationId,
                "cross-snapshot-test",
                "Cross Snapshot Test",
            );

            // Create a fresh branch with a different snapshot (no assignment for cross-snapshot-test).
            const { snapshotId: snapshotB } = await harness.setupBranchWithTest(
                organizationId,
                applicationId,
                "other-placeholder",
                "Other Placeholder",
            );

            // Request the test from snapshot A against snapshot B: no assignment exists in B.
            const results = await prepareAffectedTestGenerations(
                specs("cross-snapshot-test"),
                buildParams(harness, organizationId, applicationId, snapshotB),
            );

            expect(results).toHaveLength(0);

            // Sanity check: using snapshot A, the test is regenerable.
            const resultsA = await prepareAffectedTestGenerations(
                specs("cross-snapshot-test"),
                buildParams(harness, organizationId, applicationId, snapshotA),
            );
            expect(resultsA).toHaveLength(1);
        });
    },
});
