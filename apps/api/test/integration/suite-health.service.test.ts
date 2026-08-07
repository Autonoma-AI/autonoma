import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedAnalysisFindings } from "../seed-analysis-findings";

/**
 * `SuiteHealthService.getForApplication` derives two things from the application's first run: `hasEverRun`, which
 * is what separates the "waiting for your first pull request" empty state from "calibrating", and the `ageDays`
 * clock the steady (7d) / proven (30d) evidence gates read.
 *
 * Both are keyed off the oldest TRIGGER-created snapshot. Every application already owns a `MANUAL` snapshot the
 * moment it is created, and every suite edit in the UI mints another, so a first-run signal that counted those
 * would be true for every application in existence and would start the age clock at signup.
 */

async function createApp(harness: APITestHarness): Promise<{ applicationId: string; branchId: string }> {
    const application = await harness.services.applications.createApplication({
        name: `App ${crypto.randomUUID()}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });
    // biome-ignore lint/style/noNonNullAssertion: createApplication always creates the main branch
    return { applicationId: application.id, branchId: application.mainBranchId! };
}

/**
 * A real run: the WEBHOOK snapshot `startAnalysisRun` creates, plus the findings that make it count as a run.
 * The findings are backdated alongside the snapshot because `recentRuns` windows on the FINDING's timestamp, so
 * a run only ages out of the window when both move.
 */
async function seedRun(
    harness: APITestHarness,
    branchId: string,
    { createdAt, headSha }: { createdAt: Date; headSha: string },
): Promise<void> {
    const snapshot = await harness.db.branchSnapshot.create({
        data: { branchId, source: "WEBHOOK", status: "active", baseSha: "base", headSha, createdAt },
    });
    await harness.db.analysisJob.create({
        data: { snapshotId: snapshot.id, status: "completed", organizationId: harness.organizationId },
    });
    await seedAnalysisFindings(harness.db, snapshot.id, [{ slug: `test-${headSha}`, category: "passed" }]);
    await harness.db.analysisFinding.updateMany({ where: { reportSnapshotId: snapshot.id }, data: { createdAt } });
}

function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

apiTestSuite({
    name: "SuiteHealthService.getForApplication",
    cases: (test) => {
        test("reports hasEverRun false for an application that has only its setup snapshot", async ({ harness }) => {
            const { applicationId } = await createApp(harness);

            const health = await harness.services.suiteHealth.getForApplication(applicationId, harness.organizationId);

            // createApplication already minted a MANUAL snapshot, so a first-run signal that counted any snapshot
            // would report true here and the empty state would never render again.
            expect(health.hasEverRun).toBe(false);
            expect(health.evidence.runs).toBe(0);
        });

        test("still reports hasEverRun false when the suite was edited but never run", async ({ harness }) => {
            const { applicationId, branchId } = await createApp(harness);
            // A suite edit in the UI mints a second MANUAL snapshot. Editing tests is not running them.
            await harness.db.branchSnapshot.create({
                data: { branchId, source: "MANUAL", status: "active" },
            });

            const health = await harness.services.suiteHealth.getForApplication(applicationId, harness.organizationId);

            expect(health.hasEverRun).toBe(false);
        });

        test("reports hasEverRun true once a run exists, even after it ages out of the window", async ({ harness }) => {
            const { applicationId, branchId } = await createApp(harness);
            // Far outside SUITE_HEALTH_WINDOW_DAYS, so `recentRuns` returns nothing: "no runs lately" must not be
            // reported as "never ran".
            await seedRun(harness, branchId, { createdAt: daysAgo(400), headSha: "old" });

            const health = await harness.services.suiteHealth.getForApplication(applicationId, harness.organizationId);

            expect(health.hasEverRun).toBe(true);
            expect(health.evidence.runs).toBe(0);
        });

        test("ages the suite from its first run, not from application setup", async ({ harness }) => {
            const { applicationId, branchId } = await createApp(harness);
            // The setup snapshot is created now; the first real run happened 10 days ago in this fixture, so an
            // age clock keyed to setup would report 0 days and one keyed to the first run reports 10.
            await seedRun(harness, branchId, { createdAt: daysAgo(10), headSha: "first" });
            await seedRun(harness, branchId, { createdAt: daysAgo(1), headSha: "latest" });

            const health = await harness.services.suiteHealth.getForApplication(applicationId, harness.organizationId);

            expect(health.evidence.ageDays).toBe(10);
        });
    },
});
