import type { CostRecord } from "@autonoma/ai";
import { integrationTestSuite } from "@autonoma/integration-test";
import { logger, withObservabilityContext } from "@autonoma/logger";
import { expect } from "vitest";
import { persistAiCosts } from "../src/ai-cost-persister.service";
import { BillingTestHarness } from "./billing-harness";

function costRecord(overrides: Partial<CostRecord> = {}): CostRecord {
    return {
        model: "gpt-5.6-luna",
        tag: "analysis-impact",
        inputTokens: 1000,
        outputTokens: 100,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        costMicrodollars: 500,
        ...overrides,
    };
}

integrationTestSuite({
    name: "persistAiCosts",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("persists AiCostRecord rows stamped with the org from ambient context", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);

            await withObservabilityContext({ organization: { organizationId: orgId } }, async () => {
                await persistAiCosts(
                    harness.db,
                    [costRecord({ costMicrodollars: 500 }), costRecord({ costMicrodollars: 700 })],
                    {},
                    logger,
                );
            });

            const records = await harness.db.aiCostRecord.findMany({
                where: { organizationId: orgId },
                orderBy: { costMicrodollars: "asc" },
            });
            expect(records).toHaveLength(2);
            expect(records.map((r) => r.costMicrodollars)).toEqual([500, 700]);
        });

        test("skips persistence entirely when there is no org in ambient context", async ({ harness }) => {
            const before = await harness.db.aiCostRecord.count();

            await persistAiCosts(harness.db, [costRecord()], {}, logger);

            const after = await harness.db.aiCostRecord.count();
            expect(after).toBe(before);
        });

        test("deducts the batch's total cost from the org's balance", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);

            await withObservabilityContext({ organization: { organizationId: orgId } }, async () => {
                // 500 + 700 microdollars at the harness's default 1500 credits/USD rounds up to 2 credits.
                await persistAiCosts(
                    harness.db,
                    [costRecord({ costMicrodollars: 500 }), costRecord({ costMicrodollars: 700 })],
                    {},
                    logger,
                );
            });

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(99_998);

            const transaction = await harness.db.creditTransaction.findFirstOrThrow({
                where: { organizationId: orgId },
            });
            expect(transaction.type).toBe("AI_COST_CONSUMPTION");
            expect(transaction.amount).toBe(-2);
        });

        test("floors the deduction at the org's creditFloor instead of going more negative", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.db.billingCustomer.update({ where: { organizationId: orgId }, data: { creditFloor: -5 } });

            await withObservabilityContext({ organization: { organizationId: orgId } }, async () => {
                // Costs far more than the remaining floor room (0 down to -5) - clamps at -5, not below.
                await persistAiCosts(harness.db, [costRecord({ costMicrodollars: 1_000_000 })], {}, logger);
            });

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(-5);
        });

        test("records the cost but skips the deduction when the org's topup pricing yields no rate", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            // A hand-edited row: dividing by a zero topup amount would price the batch at an infinite
            // number of credits, so the deduction is skipped rather than charged.
            await harness.db.billingPricing.upsert({
                where: { organizationId: orgId },
                create: { organizationId: orgId, stripeTopupAmountCents: 0 },
                update: { stripeTopupAmountCents: 0 },
            });

            await withObservabilityContext({ organization: { organizationId: orgId } }, async () => {
                await persistAiCosts(harness.db, [costRecord({ costMicrodollars: 1_000_000 })], {}, logger);
            });

            const records = await harness.db.aiCostRecord.findMany({ where: { organizationId: orgId } });
            expect(records).toHaveLength(1);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(100_000);
            expect(await harness.db.creditTransaction.count({ where: { organizationId: orgId } })).toBe(0);
        });

        test("does nothing for an empty record list", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);

            await withObservabilityContext({ organization: { organizationId: orgId } }, async () => {
                await persistAiCosts(harness.db, [], {}, logger);
            });

            const records = await harness.db.aiCostRecord.findMany({ where: { organizationId: orgId } });
            expect(records).toHaveLength(0);
        });
    },
});
