import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

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
            const failedGeneration = await createReviewedGeneration(harness, fixture.snapshotId, failingPlan.id, {
                at: latestTime,
                status: "success",
                verdict: "application_bug",
                reasoning: "The submit button never becomes enabled.",
            });

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
            expect(failed).toMatchObject({
                generationId: failedGeneration.id,
                finalOutcome: "failed",
                verdict: "application_bug",
                reviewReasoning: "The submit button never becomes enabled.",
            });
        });

        test("attributes failing tests with a linked Issue to engine vs app by issue kind", async ({ harness }) => {
            const fixture = await createSnapshotDetailFixture(harness);
            const at = new Date("2026-01-01T11:00:00Z");

            // An engine-limitation failure: failed generation -> review -> engine_limitation Issue.
            const enginePlan = await createPlanFor(harness, fixture.assignments.failing);
            const engineGeneration = await createReviewedGeneration(harness, fixture.snapshotId, enginePlan.id, {
                at,
                status: "failed",
                verdict: "agent_limitation",
            });
            const engineReview = await harness.db.generationReview.findFirstOrThrow({
                where: { generationId: engineGeneration.id },
            });
            await harness.db.issue.create({
                data: {
                    kind: "engine_limitation",
                    severity: "low",
                    title: "Engine cannot interact with the canvas element",
                    description: "The drawing surface is not addressable by the driver.",
                    generationReviewId: engineReview.id,
                    organizationId: harness.organizationId,
                },
            });

            // An application-bug failure: failed generation -> review -> application_bug Issue.
            const appPlan = await createPlanFor(harness, fixture.assignments.extra);
            const appGeneration = await createReviewedGeneration(harness, fixture.snapshotId, appPlan.id, {
                at,
                status: "failed",
                verdict: "application_bug",
            });
            const appReview = await harness.db.generationReview.findFirstOrThrow({
                where: { generationId: appGeneration.id },
            });
            await harness.db.issue.create({
                data: {
                    kind: "application_bug",
                    severity: "high",
                    title: "Checkout crashes on submit",
                    description: "Submitting the order throws a 500.",
                    generationReviewId: appReview.id,
                    organizationId: harness.organizationId,
                },
            });

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.healthCounts.failing).toBe(2);
            expect(detail.summary.failingByKind).toEqual({ engine: 1, app: 1 });
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
                generation: { id: generation.id, status: "success", verdict: "success" },
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
            expect(detail.executedTests[0]).toMatchObject({
                finalOutcome: "setup_failed",
                reviewReasoning: "The staging environment never came up.",
            });
        });

        test("summary reads 'No runs' (neutral), not unhealthy, with no runs and no bugs", async ({ harness }) => {
            // Assigned tests, zero runs, zero open bugs. Must not present as "unhealthy · 0 bugs".
            const fixture = await createSnapshotDetailFixture(harness);

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.summary.executionState).toBe("not_started");
            expect(detail.summary.tone).toBe("neutral");
            expect(detail.summary.label).toBe("No runs");
            expect(detail.summary.openBugCount).toBe(0);
            expect(detail.summary.failingByKind).toEqual({ engine: 0, app: 0 });
        });
    },
});

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

async function createReviewedGeneration(
    harness: APITestHarness,
    snapshotId: string,
    testPlanId: string,
    input: {
        at: Date;
        status: "success" | "failed";
        verdict: "success" | "agent_limitation" | "application_bug" | "plan_mismatch";
        reasoning?: string;
    },
) {
    const generation = await harness.db.testGeneration.create({
        data: {
            snapshotId,
            testPlanId,
            status: input.status,
            createdAt: input.at,
            updatedAt: input.at,
            organizationId: harness.organizationId,
        },
    });
    await harness.db.generationReview.create({
        data: {
            generationId: generation.id,
            status: "completed",
            verdict: input.verdict,
            reasoning: input.reasoning,
            organizationId: harness.organizationId,
        },
    });
    return generation;
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
    await harness.db.generationReview.create({
        data: {
            generationId: generation.id,
            status: "completed",
            verdict: "success",
            reasoning: "Generation passed review.",
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
    await harness.db.generationReview.create({
        data: {
            generationId: generation.id,
            status: "completed",
            verdict: "application_bug",
            reasoning: "Generation could not satisfy the plan.",
            organizationId: harness.organizationId,
        },
    });
    return generation;
}
