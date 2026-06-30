import { CreditTransactionType } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { BillingTestHarness } from "./billing-harness";

// 1500 credits per USD (creditsPerTopup 150000 / stripeTopupAmountCents 10000 = $100).
const CREDITS_PER_USD = 1500;

integrationTestSuite({
    name: "CreditsService.deductCreditsForLlmProxy",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("deducts the converted USD cost and records an LLM_PROXY_CONSUMPTION transaction", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);

            const didDeduct = await harness.creditsService.deductCreditsForLlmProxy(orgId, 0.1, "gen-deduct-1");
            expect(didDeduct).toBe(true);

            const expectedCost = Math.ceil(0.1 * CREDITS_PER_USD); // 150
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(100_000 - expectedCost);

            const tx = await harness.db.creditTransaction.findUniqueOrThrow({ where: { id: "ctr_llm_gen-deduct-1" } });
            expect(tx.type).toBe(CreditTransactionType.LLM_PROXY_CONSUMPTION);
            expect(tx.amount).toBe(-expectedCost);
            expect(tx.balanceAfter).toBe(100_000 - expectedCost);
        });

        test("is idempotent on the request id - a retry does not double-charge", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(50_000);

            const first = await harness.creditsService.deductCreditsForLlmProxy(orgId, 1, "gen-idem-1");
            const second = await harness.creditsService.deductCreditsForLlmProxy(orgId, 1, "gen-idem-1");

            expect(first).toBe(true);
            expect(second).toBe(false);

            const expectedCost = Math.ceil(1 * CREDITS_PER_USD); // 1500
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(50_000 - expectedCost);

            const count = await harness.db.creditTransaction.count({
                where: { organizationId: orgId, type: CreditTransactionType.LLM_PROXY_CONSUMPTION },
            });
            expect(count).toBe(1);
        });

        test("clamps the balance at zero when a single request exceeds it", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100);

            // $1 -> 1500 credits, far more than the 100-credit balance.
            const didDeduct = await harness.creditsService.deductCreditsForLlmProxy(orgId, 1, "gen-clamp-1");
            expect(didDeduct).toBe(true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(0);

            const tx = await harness.db.creditTransaction.findUniqueOrThrow({ where: { id: "ctr_llm_gen-clamp-1" } });
            expect(tx.balanceAfter).toBe(0);
        });

        test("hasPositiveCreditBalance gates on a positive balance", async ({ harness }) => {
            const fundedOrg = await harness.createOrgWithBalance(10);
            const emptyOrg = await harness.createOrgWithBalance(0);

            expect(await harness.creditsService.hasPositiveCreditBalance(fundedOrg)).toBe(true);
            expect(await harness.creditsService.hasPositiveCreditBalance(emptyOrg)).toBe(false);
        });

        test("hasPositiveCreditBalance blocks an org whose grace period has expired", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(10_000);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { gracePeriodEndsAt: new Date(Date.now() - 60_000) },
            });

            expect(await harness.creditsService.hasPositiveCreditBalance(orgId)).toBe(false);
        });

        test("skips deduction for a non-positive cost", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);

            const didDeduct = await harness.creditsService.deductCreditsForLlmProxy(orgId, 0, "gen-zero-1");
            expect(didDeduct).toBe(false);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(1_000);
        });
    },
});
