import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedAnalysisFindings } from "../seed-analysis-findings";

apiTestSuite({
    name: "branches.snapshotDetail",
    cases: (test) => {
        test("returns executed test rows matching snapshot health counts", async ({ harness }) => {
            const fixture = await createSnapshotDetailFixture(harness);
            const olderTime = new Date("2026-01-01T10:00:00Z");
            const latestTime = new Date("2026-01-01T11:00:00Z");

            const passingPlan = await createPlanFor(harness, fixture.assignments.passing);
            // An earlier failed generation is superseded by the later passing one.
            await createFailedGeneration(harness, fixture.snapshotId, passingPlan.id, olderTime);
            const latestPassingGeneration = await createSuccessfulGeneration(
                harness,
                fixture.snapshotId,
                passingPlan.id,
                latestTime,
            );

            const failingPlan = await createPlanFor(harness, fixture.assignments.failing);
            const failedGeneration = await createFailedGeneration(
                harness,
                fixture.snapshotId,
                failingPlan.id,
                latestTime,
            );

            const runningPlan = await createPlanFor(harness, fixture.assignments.running);
            await createRunningGeneration(harness, fixture.snapshotId, runningPlan.id, latestTime);

            const extraPlan = await createPlanFor(harness, fixture.assignments.extra);
            await createSuccessfulGeneration(harness, fixture.snapshotId, extraPlan.id, latestTime);

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.healthCounts).toMatchObject({
                passing: 2,
                failing: 1,
                running: 1,
                totalTests: 4,
            });
            expect(detail.executedTests.map((row) => row.testCase.slug).sort()).toEqual([
                "extra-check",
                "failing-check",
                "passing-check",
                "running-check",
            ]);

            const passing = detail.executedTests.find((row) => row.testCase.slug === "passing-check");
            expect(passing).toMatchObject({
                generationId: latestPassingGeneration.id,
                status: "success",
                finalOutcome: "passed",
            });

            const failed = detail.executedTests.find((row) => row.testCase.slug === "failing-check");
            expect(failed).toMatchObject({ generationId: failedGeneration.id, finalOutcome: "failed" });
        });

        test("returns no executed rows when assignments have not run", async ({ harness }) => {
            const fixture = await createSnapshotDetailFixture(harness, { testNames: ["Waiting check"] });

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.healthCounts).toMatchObject({
                passing: 0,
                failing: 0,
                running: 0,
                notAffected: 1,
                totalTests: 1,
            });
            expect(detail.executedTests).toEqual([]);
        });

        test("returns tests created this snapshot with their coverage justification and generation", async ({
            harness,
        }) => {
            const fixture = await createSnapshotDetailFixture(harness, { testNames: ["Guest check"] });
            const assignment = fixture.assignments["guest"]!;

            await harness.db.testCase.update({
                where: { id: assignment.testCaseId },
                data: { description: "A guest can complete checkout without signing in and reach order confirmation." },
            });
            const { plan } = await attachPlan(harness, assignment);

            const generation = await createSuccessfulGeneration(
                harness,
                fixture.snapshotId,
                plan.id,
                new Date("2026-01-01T10:02:00Z"),
            );

            // Created tests carry the generation inspector, which only loads on the full
            // single-snapshot payload (the lean PR-overview fan-out skips it for query budget).
            const detail = await harness
                .request()
                .branches.snapshotDetail({ snapshotId: fixture.snapshotId, includeCreatedTests: true });

            expect(detail.createdTests).toHaveLength(1);
            expect(detail.createdTests[0]).toMatchObject({
                testCase: { id: assignment.testCaseId, slug: "guest-check" },
                description: "A guest can complete checkout without signing in and reach order confirmation.",
                plan: "Complete checkout",
                generation: { id: generation.id, status: "success" },
            });
        });

        // A test case can carry several generations in one snapshot; the row reports the newest, so a retry
        // that passed is not reported as the failure it replaced.
        test("reports the latest generation, not an earlier failed attempt", async ({ harness }) => {
            const fixture = await createSnapshotDetailFixture(harness, { testNames: ["Checkout check"] });
            const { plan } = await attachPlan(harness, fixture.assignments.checkout);

            const firstGeneration = await createFailedGeneration(
                harness,
                fixture.snapshotId,
                plan.id,
                new Date("2026-01-01T10:02:00Z"),
            );
            const passingGeneration = await createSuccessfulGeneration(
                harness,
                fixture.snapshotId,
                plan.id,
                new Date("2026-01-01T10:22:00Z"),
            );
            expect(firstGeneration.status).toBe("failed");

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.healthCounts).toMatchObject({ passing: 1, failing: 0, running: 0, totalTests: 1 });
            expect(detail.executedTests).toHaveLength(1);
            expect(detail.executedTests[0]).toMatchObject({
                generationId: passingGeneration.id,
                status: "success",
                finalOutcome: "passed",
            });
        });

        test("surfaces a scenario_setup failure as setup_failed, not failed", async ({ harness }) => {
            const fixture = await createSnapshotDetailFixture(harness, { testNames: ["Checkout check"] });
            const { plan } = await attachPlan(harness, fixture.assignments.checkout);

            await createScenarioSetupFailedGeneration(
                harness,
                fixture.snapshotId,
                plan.id,
                new Date("2026-01-01T10:02:00Z"),
                "The staging environment never came up.",
            );

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.health).toBe("critical");
            expect(detail.healthCounts).toMatchObject({
                setupFailed: 1,
                failing: 0,
                passing: 0,
                running: 0,
                totalTests: 1,
            });
            expect(detail.executedTests).toHaveLength(1);
            expect(detail.executedTests[0]).toMatchObject({ finalOutcome: "setup_failed" });
        });

        test("an analyzed snapshot reports its analysis verdict, never the legacy 'awaiting review'", async ({
            harness,
        }) => {
            // An in-flight generation on a non-processing snapshot is what used to drag a settled run to `stale`,
            // which every surface renders as "awaiting review".
            const fixture = await createSnapshotDetailFixture(harness);
            const runningPlan = await createPlanFor(harness, fixture.assignments.running);
            await createRunningGeneration(harness, fixture.snapshotId, runningPlan.id, new Date());
            await seedSettledAnalysis(harness, fixture.snapshotId);

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.analyzed).toBe(true);
            expect(detail.settled).toBe(true);
            expect(detail.summary?.executionState).not.toBe("stale");
            // And it reports what the analysis concluded, not a run tally.
            expect(detail.summary?.analysis).toMatchObject({ bugCount: 1 });
        });

        test("a snapshot the pipeline never analyzed has no summary to render", async ({ harness }) => {
            // Assigned tests, zero runs, no analysis. Inventing a summary here is what put a fabricated verdict
            // on a run that never happened; its health still reports, because that is a suite fact.
            const fixture = await createSnapshotDetailFixture(harness);

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.analyzed).toBe(false);
            expect(detail.settled).toBe(false);
            expect(detail.summary).toBeUndefined();
            // Health is a suite fact and still reports; only the analysis summary is absent.
            expect(detail.health).toBe("healthy");
        });
    },
});

/** A completed analysis job plus the report its Reporter settled - what makes a snapshot authoritative. */
async function seedSettledAnalysis(harness: APITestHarness, snapshotId: string) {
    const at = new Date();
    await harness.db.analysisJob.create({
        data: {
            snapshotId,
            organizationId: harness.organizationId,
            status: "completed",
            startedAt: at,
            completedAt: at,
        },
    });
    await seedAnalysisFindings(harness.db, snapshotId, [{ slug: "checkout", category: "client_bug" }]);
    await harness.db.analysisReport.create({
        data: {
            snapshotId,
            organizationId: harness.organizationId,
            verdict: "client_bug",
            title: "Autonoma found a bug",
            headline: "One bug.",
            reportMarkdown: "## Report",
        },
    });
}

async function attachPlan(harness: APITestHarness, assignment: { id: string; testCaseId: string }) {
    const plan = await harness.db.testPlan.create({
        data: {
            testCaseId: assignment.testCaseId,
            prompt: "Complete checkout",
            organizationId: harness.organizationId,
        },
    });
    await harness.db.testCaseAssignment.update({
        where: { id: assignment.id },
        data: { planId: plan.id },
    });
    return { plan };
}

async function createPlanFor(harness: APITestHarness, assignment: { testCaseId: string }) {
    return harness.db.testPlan.create({
        data: {
            testCaseId: assignment.testCaseId,
            prompt: "Complete checkout",
            organizationId: harness.organizationId,
        },
    });
}

async function createSnapshotDetailFixture(harness: APITestHarness, input: { testNames?: string[] } = {}) {
    const application = await harness.services.applications.createApplication({
        name: `Snapshot Detail ${crypto.randomUUID()}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/default-file.png",
    });
    const branch = await harness.db.branch.findFirstOrThrow({
        where: { applicationId: application.id },
        select: { id: true, activeSnapshotId: true },
    });
    if (branch.activeSnapshotId == null) throw new Error("Expected createApplication to create an active snapshot");

    await harness.db.branchSnapshot.update({
        where: { id: branch.activeSnapshotId },
        data: { status: "active", baseSha: "base-sha", headSha: "head-sha" },
    });
    const folder = await harness.db.folder.create({
        data: {
            name: "Default",
            applicationId: application.id,
            organizationId: harness.organizationId,
        },
    });

    const names = input.testNames ?? ["Passing check", "Failing check", "Running check", "Extra check"];
    const assignments: Record<string, { id: string; testCaseId: string }> = {};
    for (const name of names) {
        const slug = name.toLowerCase().replaceAll(" ", "-");
        const testCase = await harness.db.testCase.create({
            data: {
                name,
                slug,
                applicationId: application.id,
                folderId: folder.id,
                organizationId: harness.organizationId,
            },
        });
        const assignment = await harness.db.testCaseAssignment.create({
            data: {
                snapshotId: branch.activeSnapshotId,
                testCaseId: testCase.id,
            },
        });
        assignments[slug.replace("-check", "")] = { id: assignment.id, testCaseId: testCase.id };
    }

    return {
        snapshotId: branch.activeSnapshotId,
        assignments,
    };
}

async function createScenarioSetupFailedGeneration(
    harness: APITestHarness,
    snapshotId: string,
    testPlanId: string,
    at: Date,
    message: string,
) {
    return harness.db.testGeneration.create({
        data: {
            snapshotId,
            testPlanId,
            status: "failed",
            failure: { kind: "scenario_setup", message },
            createdAt: at,
            updatedAt: at,
            organizationId: harness.organizationId,
        },
    });
}

async function createRunningGeneration(harness: APITestHarness, snapshotId: string, testPlanId: string, at: Date) {
    return harness.db.testGeneration.create({
        data: {
            snapshotId,
            testPlanId,
            status: "running",
            createdAt: at,
            updatedAt: at,
            organizationId: harness.organizationId,
        },
    });
}

async function createSuccessfulGeneration(harness: APITestHarness, snapshotId: string, testPlanId: string, at: Date) {
    const generation = await harness.db.testGeneration.create({
        data: {
            snapshotId,
            testPlanId,
            status: "success",
            createdAt: at,
            updatedAt: at,
            organizationId: harness.organizationId,
        },
    });
    return generation;
}

async function createFailedGeneration(harness: APITestHarness, snapshotId: string, testPlanId: string, at: Date) {
    const generation = await harness.db.testGeneration.create({
        data: {
            snapshotId,
            testPlanId,
            status: "failed",
            createdAt: at,
            updatedAt: at,
            organizationId: harness.organizationId,
        },
    });
    return generation;
}
