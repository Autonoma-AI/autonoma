import { CreditTransactionType } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { BillingTestHarness } from "./billing-harness";

// 1500 credits per USD (creditsPerTopup 150000 / stripeTopupAmountCents 10000 = $100).
const CREDITS_PER_USD = 1500;

// Free CLI credit cap used across the gate tests.
const FREE_CAP = 20_000;

// Insert a credit_transaction row directly so a gate test can set up lifetime
// proxy spend / purchase history without going through the deduction paths.
async function recordTransaction(
    harness: BillingTestHarness,
    organizationId: string,
    idSuffix: string,
    type: CreditTransactionType,
    amount: number,
): Promise<void> {
    await harness.db.creditTransaction.create({
        data: { id: `ctr_test_${idSuffix}`, organizationId, type, amount, balanceAfter: 0 },
    });
}

// Record `credits` of lifetime LLM proxy spend (a negative-amount consumption row).
async function recordProxySpend(
    harness: BillingTestHarness,
    organizationId: string,
    idSuffix: string,
    credits: number,
): Promise<void> {
    await recordTransaction(harness, organizationId, idSuffix, CreditTransactionType.LLM_PROXY_CONSUMPTION, -credits);
}

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

        test("gate allows a funded org and blocks an empty one with out_of_credits", async ({ harness }) => {
            const fundedOrg = await harness.createOrgWithBalance(10);
            const emptyOrg = await harness.createOrgWithBalance(0);

            expect(await harness.creditsService.checkLlmProxyGate(fundedOrg, FREE_CAP)).toEqual({ allowed: true });
            expect(await harness.creditsService.checkLlmProxyGate(emptyOrg, FREE_CAP)).toEqual({
                allowed: false,
                reason: "out_of_credits",
            });
        });

        test("gate blocks an org whose grace period has expired", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(10_000);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { gracePeriodEndsAt: new Date(Date.now() - 60_000) },
            });

            expect(await harness.creditsService.checkLlmProxyGate(orgId, FREE_CAP)).toEqual({
                allowed: false,
                reason: "grace_period_expired",
            });
        });

        test("gate blocks a never-paid org that has spent the free CLI cap", async ({ harness }) => {
            // Fund well above zero so the balance check passes - it's the cap, not
            // an empty wallet, that must block here.
            const orgId = await harness.createOrgWithBalance(100_000);
            await recordProxySpend(harness, orgId, "spent-at-cap", FREE_CAP);

            expect(await harness.creditsService.checkLlmProxyGate(orgId, FREE_CAP)).toEqual({
                allowed: false,
                reason: "free_cli_limit_reached",
            });
        });

        test("gate allows a never-paid org still under the free CLI cap", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            await recordProxySpend(harness, orgId, "spent-under-cap", FREE_CAP - 1);

            expect(await harness.creditsService.checkLlmProxyGate(orgId, FREE_CAP)).toEqual({ allowed: true });
        });

        test("gate raises the CLI budget by net top-up purchases", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            await recordProxySpend(harness, orgId, "spent-over-free", FREE_CAP + 5_000);

            // Over the free cap alone -> blocked...
            expect(await harness.creditsService.checkLlmProxyGate(orgId, FREE_CAP)).toEqual({
                allowed: false,
                reason: "free_cli_limit_reached",
            });

            // ...but a 50k top-up purchase lifts the budget above what was spent.
            await recordTransaction(harness, orgId, "topup-buy", CreditTransactionType.TOPUP_PURCHASE, 50_000);
            expect(await harness.creditsService.checkLlmProxyGate(orgId, FREE_CAP)).toEqual({ allowed: true });

            // A full refund of that top-up drops the budget back to the free cap.
            await recordTransaction(harness, orgId, "topup-refund", CreditTransactionType.TOPUP_REFUND, -50_000);
            expect(await harness.creditsService.checkLlmProxyGate(orgId, FREE_CAP)).toEqual({
                allowed: false,
                reason: "free_cli_limit_reached",
            });
        });

        test("gate exempts an org with an active subscription from the cap", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            await recordProxySpend(harness, orgId, "sub-over-cap", FREE_CAP * 2);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { subscriptionStatus: "active" },
            });

            expect(await harness.creditsService.checkLlmProxyGate(orgId, FREE_CAP)).toEqual({ allowed: true });
        });

        test("gate credits subscription grants toward the budget for a lapsed subscriber", async ({ harness }) => {
            // Spent over the free cap while subscribed, then cancelled - no longer
            // exempt, but the subscription grant must keep them out of the block.
            const orgId = await harness.createOrgWithBalance(100_000);
            await recordProxySpend(harness, orgId, "lapsed-spend", FREE_CAP * 2);
            await recordTransaction(harness, orgId, "sub-grant", CreditTransactionType.SUBSCRIPTION_GRANT, 1_000_000);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { subscriptionStatus: "canceled" },
            });

            expect(await harness.creditsService.checkLlmProxyGate(orgId, FREE_CAP)).toEqual({ allowed: true });
        });

        test("gate does not exempt a trialing subscription from the cap", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            await recordProxySpend(harness, orgId, "trial-over-cap", FREE_CAP * 2);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { subscriptionStatus: "trialing" },
            });

            expect(await harness.creditsService.checkLlmProxyGate(orgId, FREE_CAP)).toEqual({
                allowed: false,
                reason: "free_cli_limit_reached",
            });
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
