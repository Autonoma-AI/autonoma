import { CreditTransactionType } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { BillingTestHarness } from "./billing-harness";

// 10 credits/vCPU-hour, 2 credits/GB-memory-hour - arbitrary non-zero rates so
// the ceil-to-1-minimum charge is exercised deterministically.
const CREDITS_PER_VCPU_HOUR = 10;
const CREDITS_PER_GB_MEMORY_HOUR = 2;

async function setPreviewUsageRates(harness: BillingTestHarness, organizationId: string): Promise<void> {
    await harness.db.billingPricing.upsert({
        where: { organizationId },
        create: {
            organizationId,
            creditsPerVcpuHour: CREDITS_PER_VCPU_HOUR,
            creditsPerGbMemoryHour: CREDITS_PER_GB_MEMORY_HOUR,
        },
        update: {
            creditsPerVcpuHour: CREDITS_PER_VCPU_HOUR,
            creditsPerGbMemoryHour: CREDITS_PER_GB_MEMORY_HOUR,
        },
    });
}

integrationTestSuite({
    name: "CreditsService.deductCreditsForPreviewUsage",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("deducts the computed cost and records a PREVIEW_RUNTIME_CONSUMPTION transaction", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            await setPreviewUsageRates(harness, orgId);

            // 900 vCPU-seconds (0.25h) * 10 credits/h = 2.5; 3600 GB-seconds (1h) * 2 credits/h = 2 -> 4.5, ceil to 5.
            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(
                orgId,
                "win-deduct-1",
                900,
                3600,
            );
            expect(didDeduct).toBe(true);

            const expectedCost = 5;
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(100_000 - expectedCost);

            const tx = await harness.db.creditTransaction.findUniqueOrThrow({
                where: { id: "ctr_preview_win-deduct-1" },
            });
            expect(tx.type).toBe(CreditTransactionType.PREVIEW_RUNTIME_CONSUMPTION);
            expect(tx.amount).toBe(-expectedCost);
            expect(tx.balanceAfter).toBe(100_000 - expectedCost);
            expect(tx.usageWindowId).toBe("win-deduct-1");
        });

        test("rounds a sub-credit cost up to a minimum of 1 credit", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            await setPreviewUsageRates(harness, orgId);

            // 36 vCPU-seconds (0.01h) * 10 credits/h = 0.1 credits, far below 1.
            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(orgId, "win-min-1", 36, 0);
            expect(didDeduct).toBe(true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(999);
        });

        test("is idempotent on the usage window id - a retry does not double-charge", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(50_000);
            await setPreviewUsageRates(harness, orgId);

            const first = await harness.creditsService.deductCreditsForPreviewUsage(orgId, "win-idem-1", 3600, 3600);
            const second = await harness.creditsService.deductCreditsForPreviewUsage(orgId, "win-idem-1", 3600, 3600);

            expect(first).toBe(true);
            expect(second).toBe(false);

            const expectedCost = CREDITS_PER_VCPU_HOUR + CREDITS_PER_GB_MEMORY_HOUR; // 12
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(50_000 - expectedCost);

            const count = await harness.db.creditTransaction.count({
                where: { organizationId: orgId, type: CreditTransactionType.PREVIEW_RUNTIME_CONSUMPTION },
            });
            expect(count).toBe(1);
        });

        test("clamps the balance at zero when a single window exceeds it", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(5);
            await setPreviewUsageRates(harness, orgId);

            // 1h vCPU + 1h memory -> 12 credits, far more than the 5-credit balance.
            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(
                orgId,
                "win-clamp-1",
                3600,
                3600,
            );
            expect(didDeduct).toBe(true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(0);

            const tx = await harness.db.creditTransaction.findUniqueOrThrow({
                where: { id: "ctr_preview_win-clamp-1" },
            });
            expect(tx.balanceAfter).toBe(0);
        });

        test("draws from the subscription pool before the top-up pool, floored at zero", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(20);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { subscriptionCreditBalance: 8 },
            });
            await setPreviewUsageRates(harness, orgId);

            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(orgId, "win-sub-1", 3600, 3600);
            expect(didDeduct).toBe(true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(8); // 20 - 12
            expect(customer.subscriptionCreditBalance).toBe(0); // 8 - min(8, 12), floored at 0
        });

        test("skips deduction when both rates are zero (the shadow-mode default)", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);

            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(
                orgId,
                "win-zero-rate-1",
                3600,
                3600,
            );
            expect(didDeduct).toBe(false);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(1_000);
        });

        test("skips deduction for a degraded window with zero measured usage", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            await setPreviewUsageRates(harness, orgId);

            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(orgId, "win-degraded-1", 0, 0);
            expect(didDeduct).toBe(false);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(1_000);
        });
    },
});
