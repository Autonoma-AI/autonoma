import { Registry } from "prom-client";
import { expect } from "vitest";
import { PreviewkitBuildMetrics } from "../../src/metrics/previewkit-build-metrics";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

const REPO_FULL_NAME = "acme/web";

/** Renders the registry the way a Prometheus scrape would and extracts the gauge value. */
async function scrapeBuildsInFlight(registry: Registry): Promise<number> {
    const body = await registry.metrics();
    const value = body.match(/^previewkit_app_builds_in_flight (\d+)$/m)?.[1];
    if (value == null) throw new Error(`previewkit_app_builds_in_flight line missing in:\n${body}`);
    return Number(value);
}

async function createEnvironment(
    harness: APITestHarness,
    prNumber: number,
    status: "building" | "torn_down" | "failed",
) {
    return await harness.db.previewkitEnvironment.create({
        data: {
            namespace: `preview-acme-web-pr-${prNumber}`,
            repoFullName: REPO_FULL_NAME,
            prNumber,
            headSha: `head-${prNumber}`,
            headRef: `feature/pr-${prNumber}`,
            status,
            organizationId: harness.organizationId,
        },
    });
}

apiTestSuite({
    name: "previewkit build metrics",
    cases: (test) => {
        // One sequential case: the gauge counts the whole DB, so splitting into
        // separate cases would let earlier fixtures leak into later asserts
        // (the suite shares one database across cases).
        test("counts fresh building apps on live environments, drops stale and dead-env rows", async ({ harness }) => {
            const registry = new Registry();
            new PreviewkitBuildMetrics(harness.db, registry);

            const liveEnv = await createEnvironment(harness, 1, "building");
            const tornDownEnv = await createEnvironment(harness, 2, "torn_down");
            const failedEnv = await createEnvironment(harness, 3, "failed");

            // Two in-flight builds on the live environment...
            await harness.db.previewkitAppInstance.createMany({
                data: [
                    { environmentId: liveEnv.id, appName: "web", status: "building", port: 3000 },
                    { environmentId: liveEnv.id, appName: "api", status: "building", port: 4000 },
                    // ...and siblings in every non-building state, none of which count.
                    { environmentId: liveEnv.id, appName: "docs", status: "pending", port: 3001 },
                    { environmentId: liveEnv.id, appName: "worker", status: "built", port: 3002 },
                    { environmentId: liveEnv.id, appName: "admin", status: "deploying", port: 3003 },
                    { environmentId: liveEnv.id, appName: "site", status: "ready", port: 3004 },
                    { environmentId: liveEnv.id, appName: "cron", status: "build_failed", port: 3005 },
                ],
            });
            // `building` rows on dead environments never count - a PR closed
            // mid-build tears the env down without a terminal app state.
            await harness.db.previewkitAppInstance.createMany({
                data: [
                    { environmentId: tornDownEnv.id, appName: "web", status: "building", port: 3000 },
                    { environmentId: failedEnv.id, appName: "web", status: "building", port: 3000 },
                ],
            });

            expect(await scrapeBuildsInFlight(registry)).toBe(2);

            // Backdate the live builds past the 90-minute leak-guard window with
            // raw SQL - Prisma's @updatedAt always stamps `now()` through the
            // client. A runner that died without writing a terminal state must
            // stop inflating the gauge once the window passes.
            await harness.db.$executeRaw`
                UPDATE previewkit_app_instance
                SET updated_at = now() - interval '2 hours'
                WHERE environment_id = ${liveEnv.id} AND status = 'building'
            `;

            expect(await scrapeBuildsInFlight(registry)).toBe(0);
        });
    },
});
