import { integrationTestSuite } from "@autonoma/integration-test";
import { logger } from "@autonoma/logger";
import { expect } from "vitest";
import { fetchRecentBuildCapacityMix } from "../../src/aws-pricing/build-capacity-mix";
import { BillingTestHarness } from "../billing-harness";

integrationTestSuite({
    name: "fetchRecentBuildCapacityMix",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("computes the spot fraction from recent, resolved-capacity-type usage rows", async ({ harness }) => {
            const organizationId = await harness.createOrgWithBalance(100_000);
            const env = await harness.createPreviewkitEnvironment({ organizationId });
            const build = await harness.db.previewkitBuild.create({
                data: { environmentId: env.id, headSha: "abc1234", status: "ready", durationMs: 30_000 },
            });

            await createAppBuildUsage(harness, build.id, "web", organizationId, "spot");
            await createAppBuildUsage(harness, build.id, "api", organizationId, "spot");
            await createAppBuildUsage(harness, build.id, "worker", organizationId, "on-demand");
            // No resolved capacity type (a best-effort node lookup that failed) - excluded from the ratio.
            await createAppBuildUsage(harness, build.id, "cron", organizationId, undefined);

            const mix = await fetchRecentBuildCapacityMix(harness.db, new Date(0), logger);

            expect(mix).toEqual({ spotFraction: 2 / 3, sampleSize: 3 });
        });

        test("weights the spot fraction by vcpuSeconds, not by build count", async ({ harness }) => {
            const organizationId = await harness.createOrgWithBalance(100_000);
            const env = await harness.createPreviewkitEnvironment({ organizationId });
            const build = await harness.db.previewkitBuild.create({
                data: { environmentId: env.id, headSha: "abc1234", status: "ready", durationMs: 30_000 },
            });

            // A 1-minute spot build and a 60-minute on-demand build are one build each - if
            // weighted by count that's 50% spot, but by compute-time it's 1/61.
            await createAppBuildUsage(harness, build.id, "short-spot", organizationId, "spot", undefined, 60);
            await createAppBuildUsage(
                harness,
                build.id,
                "long-on-demand",
                organizationId,
                "on-demand",
                undefined,
                3_600,
            );

            const mix = await fetchRecentBuildCapacityMix(harness.db, new Date(0), logger);

            expect(mix).toEqual({ spotFraction: 60 / 3_660, sampleSize: 2 });
        });

        test("excludes rows created before the given window", async ({ harness }) => {
            const organizationId = await harness.createOrgWithBalance(100_000);
            const env = await harness.createPreviewkitEnvironment({ organizationId });
            const build = await harness.db.previewkitBuild.create({
                data: { environmentId: env.id, headSha: "abc1234", status: "ready", durationMs: 30_000 },
            });

            await createAppBuildUsage(harness, build.id, "old", organizationId, "on-demand", new Date("2020-01-01"));
            await createAppBuildUsage(harness, build.id, "recent", organizationId, "spot");

            const mix = await fetchRecentBuildCapacityMix(harness.db, new Date("2025-01-01"), logger);

            expect(mix).toEqual({ spotFraction: 1, sampleSize: 1 });
        });

        test("returns undefined when there is no usable data in the window", async ({ harness }) => {
            const mix = await fetchRecentBuildCapacityMix(harness.db, new Date(0), logger);

            expect(mix).toBeUndefined();
        });
    },
});

async function createAppBuildUsage(
    harness: BillingTestHarness,
    buildId: string,
    appName: string,
    organizationId: string,
    capacityType: string | undefined,
    createdAt?: Date,
    vcpuSeconds = 40,
) {
    const appId = await harness.createPreviewkitApp(organizationId, appName);
    const appBuild = await harness.db.previewkitAppBuild.create({
        data: { buildId, appId, appName, status: "success", durationMs: 10_000, imageTag: `image:${appName}` },
    });
    await harness.db.previewkitAppBuildUsage.create({
        data: {
            appBuildId: appBuild.id,
            organizationId,
            vcpuSeconds,
            gbSeconds: vcpuSeconds * 4,
            capacityType,
            createdAt,
        },
    });
}
