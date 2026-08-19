import { CreditTransactionType } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { logger } from "@autonoma/logger";
import { expect } from "vitest";
import { deductCreditsForBuildUsage } from "../src/deduct-credits-for-build-usage";
import { BillingTestHarness } from "./billing-harness";

const CREDITS_PER_VCPU_HOUR = 10;
const CREDITS_PER_GB_MEMORY_HOUR = 2;

async function setBuildUsageRates(harness: BillingTestHarness, organizationId: string): Promise<void> {
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
    name: "deductCreditsForBuildUsage",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("deducts the computed cost and records a PREVIEW_BUILD_CONSUMPTION transaction", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            await setBuildUsageRates(harness, orgId);

            // 900 vCPU-seconds (0.25h) * 10 credits/h = 2.5; 3600 GB-seconds (1h) * 2 credits/h = 2 -> 4.5, ceil to 5.
            await deductCreditsForBuildUsage(harness.db, orgId, "build-1", 900, 3600, logger);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(100_000 - 5);

            const tx = await harness.db.creditTransaction.findUniqueOrThrow({ where: { id: "ctr_build_build-1" } });
            expect(tx.type).toBe(CreditTransactionType.PREVIEW_BUILD_CONSUMPTION);
            expect(tx.amount).toBe(-5);
            expect(tx.previewkitAppBuildId).toBe("build-1");
        });

        test("is idempotent on the app build id - a retry does not double-charge", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(50_000);
            await setBuildUsageRates(harness, orgId);

            await deductCreditsForBuildUsage(harness.db, orgId, "build-idem-1", 3600, 3600, logger);
            await deductCreditsForBuildUsage(harness.db, orgId, "build-idem-1", 3600, 3600, logger);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(50_000 - (CREDITS_PER_VCPU_HOUR + CREDITS_PER_GB_MEMORY_HOUR));

            const count = await harness.db.creditTransaction.count({
                where: { organizationId: orgId, type: CreditTransactionType.PREVIEW_BUILD_CONSUMPTION },
            });
            expect(count).toBe(1);
        });

        test("clamps at the org's own negative credit floor instead of zero", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(5);
            await harness.db.billingCustomer.update({ where: { organizationId: orgId }, data: { creditFloor: -20 } });
            await setBuildUsageRates(harness, orgId);

            await deductCreditsForBuildUsage(harness.db, orgId, "build-floor-1", 3600, 3600, logger);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(-7); // 5 - 12 = -7, above the -20 floor
        });

        test("skips deduction when both rates are zero (the shadow-mode default)", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);

            await deductCreditsForBuildUsage(harness.db, orgId, "build-zero-rate-1", 3600, 3600, logger);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(1_000);
        });
    },
});
