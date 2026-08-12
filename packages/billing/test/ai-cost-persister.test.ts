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

        test("never touches credits - recording only, no deduction", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);

            await withObservabilityContext({ organization: { organizationId: orgId } }, async () => {
                await persistAiCosts(harness.db, [costRecord()], {}, logger);
            });

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(100_000);

            const count = await harness.db.creditTransaction.count({ where: { organizationId: orgId } });
            expect(count).toBe(0);
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
