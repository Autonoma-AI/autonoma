import { CreditTransactionType, PreviewkitStatus } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { AmpPrometheusClient } from "../src/preview-usage-meter/amp-prometheus-client";
import { PreviewUsageMeterSweepService } from "../src/preview-usage-meter/preview-usage-meter-sweep.service";
import { BillingTestHarness } from "./billing-harness";
import { FakeAmpRequestSender } from "./fake-amp-request-sender";

/** Always throws - stands in for a transient billing-service failure (DB hiccup, network blip). */
const throwingBillingService = {
    deductCreditsForPreviewUsage: async (): Promise<boolean> => {
        throw new Error("simulated deduction failure");
    },
};

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
        update: { creditsPerVcpuHour: CREDITS_PER_VCPU_HOUR, creditsPerGbMemoryHour: CREDITS_PER_GB_MEMORY_HOUR },
    });
}

function buildSweep(harness: BillingTestHarness, sender: FakeAmpRequestSender): PreviewUsageMeterSweepService {
    return new PreviewUsageMeterSweepService(harness.db, new AmpPrometheusClient(sender), harness.billingService);
}

integrationTestSuite({
    name: "PreviewUsageMeterSweepService",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("closes a single due window and deducts credits", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            await setPreviewUsageRates(harness, orgId);
            const env = await harness.createPreviewkitEnvironment({
                organizationId: orgId,
                deployedAt: new Date("2026-07-21T12:30:00.000Z"),
            });

            const sender = new FakeAmpRequestSender();
            const windowEnd = new Date("2026-07-21T12:45:00.000Z");
            sender.respondAt(windowEnd, {
                cpu: [{ namespace: env.namespace, value: 900 }], // 0.25h * 10 credits/h = 2.5
                memory: [{ namespace: env.namespace, value: 1 }], // 1 GB avg * 1h * 2 credits/h = 2
            });

            const result = await buildSweep(harness, sender).run(new Date("2026-07-21T13:00:00.000Z"));
            expect(result).toEqual({ windowsClosed: 1, environmentsMetered: 1 });

            const window = await harness.db.previewkitUsageWindow.findUniqueOrThrow({
                where: {
                    environmentId_windowStart: {
                        environmentId: env.id,
                        windowStart: new Date("2026-07-21T12:30:00.000Z"),
                    },
                },
            });
            expect(window.windowEnd).toEqual(windowEnd);
            expect(window.vcpuSeconds).toBe(900);
            expect(window.gbSeconds).toBe(900); // 1 GB avg * 900s (15min) window
            expect(window.degraded).toBe(false);
            expect(window.organizationId).toBe(orgId);

            const updatedEnv = await harness.db.previewkitEnvironment.findUniqueOrThrow({ where: { id: env.id } });
            expect(updatedEnv.meteredAt).toEqual(windowEnd);

            const expectedCost = Math.ceil(
                (900 / 3600) * CREDITS_PER_VCPU_HOUR + (900 / 3600) * CREDITS_PER_GB_MEMORY_HOUR,
            ); // ceil(2.5+0.5)=3
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(100_000 - expectedCost);

            const tx = await harness.db.creditTransaction.findFirstOrThrow({
                where: { organizationId: orgId, type: CreditTransactionType.PREVIEW_RUNTIME_CONSUMPTION },
            });
            expect(tx.usageWindowId).toBe(window.id);
        });

        test("is idempotent - a second run at the same time makes no further changes", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            await setPreviewUsageRates(harness, orgId);
            const env = await harness.createPreviewkitEnvironment({
                organizationId: orgId,
                deployedAt: new Date("2026-07-21T12:30:00.000Z"),
            });

            const sender = new FakeAmpRequestSender();
            const now = new Date("2026-07-21T13:00:00.000Z");
            const sweep = buildSweep(harness, sender);

            const first = await sweep.run(now);
            const second = await sweep.run(now);

            expect(first).toEqual({ windowsClosed: 1, environmentsMetered: 1 });
            expect(second).toEqual({ windowsClosed: 0, environmentsMetered: 0 });

            const windowCount = await harness.db.previewkitUsageWindow.count({ where: { environmentId: env.id } });
            expect(windowCount).toBe(1);
        });

        test("caps catch-up per run and finishes over subsequent runs", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            await harness.createPreviewkitEnvironment({
                organizationId: orgId,
                deployedAt: new Date("2026-07-21T18:45:00.000Z"),
            });

            const sender = new FakeAmpRequestSender();
            const now = new Date("2026-07-22T00:00:00.000Z");
            const sweep = buildSweep(harness, sender);

            const first = await sweep.run(now);
            expect(first).toEqual({ windowsClosed: 16, environmentsMetered: 16 });

            const second = await sweep.run(now);
            expect(second).toEqual({ windowsClosed: 4, environmentsMetered: 4 });

            const third = await sweep.run(now);
            expect(third).toEqual({ windowsClosed: 0, environmentsMetered: 0 });
        });

        test("closes the trailing window for a recently torn-down environment then stops metering it", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            const env = await harness.createPreviewkitEnvironment({
                organizationId: orgId,
                status: PreviewkitStatus.torn_down,
                deployedAt: new Date("2026-07-21T09:00:00.000Z"),
                tornDownAt: new Date("2026-07-21T09:25:00.000Z"),
            });

            const sender = new FakeAmpRequestSender();
            const now = new Date("2026-07-21T10:00:00.000Z");
            const sweep = buildSweep(harness, sender);

            const first = await sweep.run(now);
            expect(first).toEqual({ windowsClosed: 1, environmentsMetered: 1 });

            const updatedEnv = await harness.db.previewkitEnvironment.findUniqueOrThrow({ where: { id: env.id } });
            expect(updatedEnv.meteredAt).toEqual(new Date("2026-07-21T09:15:00.000Z"));

            const second = await sweep.run(now);
            expect(second).toEqual({ windowsClosed: 0, environmentsMetered: 0 });
        });

        test("does not advance the checkpoint when an AMP query fails", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            const env = await harness.createPreviewkitEnvironment({
                organizationId: orgId,
                deployedAt: new Date("2026-07-21T12:30:00.000Z"),
            });

            const sender = new FakeAmpRequestSender();
            sender.respondAt(new Date("2026-07-21T12:45:00.000Z"), { cpu: "error" });

            const result = await buildSweep(harness, sender).run(new Date("2026-07-21T13:00:00.000Z"));
            expect(result).toEqual({ windowsClosed: 0, environmentsMetered: 0 });

            const windowCount = await harness.db.previewkitUsageWindow.count({ where: { environmentId: env.id } });
            expect(windowCount).toBe(0);

            const updatedEnv = await harness.db.previewkitEnvironment.findUniqueOrThrow({ where: { id: env.id } });
            expect(updatedEnv.meteredAt).toBeNull();
        });

        test("marks consecutive zero-sample windows as degraded", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            const env = await harness.createPreviewkitEnvironment({
                organizationId: orgId,
                deployedAt: new Date("2026-07-21T12:15:00.000Z"),
            });

            // No respondAt configured for either window - the fake sender defaults to
            // an empty result vector, simulating a scraper that isn't collecting.
            const sender = new FakeAmpRequestSender();
            const now = new Date("2026-07-21T13:00:00.000Z");

            const result = await buildSweep(harness, sender).run(now);
            expect(result.windowsClosed).toBe(2);

            const windows = await harness.db.previewkitUsageWindow.findMany({
                where: { environmentId: env.id },
                orderBy: { windowStart: "asc" },
            });
            expect(windows).toHaveLength(2);
            expect(windows.every((w) => w.degraded)).toBe(true);
            expect(windows.every((w) => w.vcpuSeconds === 0 && w.gbSeconds === 0)).toBe(true);

            // Zero-usage windows never charge a credit, degraded or not.
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(100_000);
        });

        test("leaves the checkpoint behind when the credit deduction fails, and retries it successfully next run", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            await setPreviewUsageRates(harness, orgId);
            const env = await harness.createPreviewkitEnvironment({
                organizationId: orgId,
                deployedAt: new Date("2026-07-21T12:30:00.000Z"),
            });

            const sender = new FakeAmpRequestSender();
            const windowEnd = new Date("2026-07-21T12:45:00.000Z");
            sender.respondAt(windowEnd, {
                cpu: [{ namespace: env.namespace, value: 900 }],
                memory: [{ namespace: env.namespace, value: 1 }],
            });
            const now = new Date("2026-07-21T13:00:00.000Z");

            const failingSweep = new PreviewUsageMeterSweepService(
                harness.db,
                new AmpPrometheusClient(sender),
                throwingBillingService,
            );
            const failedResult = await failingSweep.run(now);
            expect(failedResult).toEqual({ windowsClosed: 1, environmentsMetered: 0 });

            // The window row is written regardless - it's useful usage data on its own -
            // but the checkpoint must not advance past a window whose deduction failed.
            const window = await harness.db.previewkitUsageWindow.findUniqueOrThrow({
                where: {
                    environmentId_windowStart: {
                        environmentId: env.id,
                        windowStart: new Date("2026-07-21T12:30:00.000Z"),
                    },
                },
            });
            const envAfterFailure = await harness.db.previewkitEnvironment.findUniqueOrThrow({ where: { id: env.id } });
            expect(envAfterFailure.meteredAt).toBeNull();
            const balanceAfterFailure = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
            });
            expect(balanceAfterFailure.creditBalance).toBe(100_000);

            // Retrying with a working billing service closes the same window (idempotent
            // upsert - same window id) and completes the deduction this time.
            const retriedResult = await buildSweep(harness, sender).run(now);
            expect(retriedResult).toEqual({ windowsClosed: 1, environmentsMetered: 1 });

            const windowCount = await harness.db.previewkitUsageWindow.count({ where: { environmentId: env.id } });
            expect(windowCount).toBe(1);

            const envAfterRetry = await harness.db.previewkitEnvironment.findUniqueOrThrow({ where: { id: env.id } });
            expect(envAfterRetry.meteredAt).toEqual(windowEnd);

            const expectedCost = Math.ceil(
                (900 / 3600) * CREDITS_PER_VCPU_HOUR + (900 / 3600) * CREDITS_PER_GB_MEMORY_HOUR,
            );
            const balanceAfterRetry = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
            });
            expect(balanceAfterRetry.creditBalance).toBe(100_000 - expectedCost);

            const tx = await harness.db.creditTransaction.findFirstOrThrow({
                where: { organizationId: orgId, type: CreditTransactionType.PREVIEW_RUNTIME_CONSUMPTION },
            });
            expect(tx.usageWindowId).toBe(window.id);
        });
    },
});
