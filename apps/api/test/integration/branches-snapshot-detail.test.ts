import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

apiTestSuite({
    name: "branches.snapshotDetail",
    cases: (test) => {
        test("returns executed test rows matching snapshot health counts", async ({ harness }) => {
            const fixture = await createSnapshotDetailFixture(harness);
            const olderRunTime = new Date("2026-01-01T10:00:00Z");
            const latestRunTime = new Date("2026-01-01T11:00:00Z");

            await createRun(harness, fixture.assignments.passing.id, "failed", olderRunTime);
            const latestPassingRun = await createRun(harness, fixture.assignments.passing.id, "success", latestRunTime);
            const failedRun = await createRun(harness, fixture.assignments.failing.id, "failed", latestRunTime);
            await harness.db.runReview.create({
                data: {
                    runId: failedRun.id,
                    status: "completed",
                    verdict: "application_bug",
                    reasoning: "The submit button never becomes enabled.",
                    organizationId: harness.organizationId,
                },
            });
            await createRun(harness, fixture.assignments.running.id, "running", latestRunTime);
            await createRun(harness, fixture.assignments.quarantined.id, "success", latestRunTime);

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.healthCounts).toMatchObject({
                passing: 1,
                failing: 1,
                running: 1,
                quarantined: 1,
                totalTests: 4,
            });
            expect(detail.executedTests.map((row) => row.testCase.slug).sort()).toEqual([
                "failing-check",
                "passing-check",
                "running-check",
            ]);

            const passing = detail.executedTests.find((row) => row.testCase.slug === "passing-check");
            expect(passing).toMatchObject({
                runId: latestPassingRun.id,
                status: "success",
            });

            const failed = detail.executedTests.find((row) => row.testCase.slug === "failing-check");
            expect(failed).toMatchObject({
                runId: failedRun.id,
                status: "failed",
                verdict: "application_bug",
                reviewReasoning: "The submit button never becomes enabled.",
            });
        });

        test("returns no executed rows when assignments have not run", async ({ harness }) => {
            const fixture = await createSnapshotDetailFixture(harness, { testNames: ["Waiting check"] });

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.healthCounts).toMatchObject({
                passing: 0,
                failing: 0,
                running: 0,
                quarantined: 0,
                notAffected: 1,
                totalTests: 1,
            });
            expect(detail.executedTests).toEqual([]);
        });

        test("returns tests created this snapshot with their coverage justification and generation/run", async ({
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
            const run = await createRun(harness, assignment.id, "success", new Date("2026-01-01T10:05:00Z"), {
                planId: plan.id,
            });

            // Created tests carry the generation/run inspector, which only loads on the full
            // single-snapshot payload (the lean PR-overview fan-out skips it for query budget).
            const detail = await harness
                .request()
                .branches.snapshotDetail({ snapshotId: fixture.snapshotId, includeRefinementLoop: true });

            expect(detail.createdTests).toHaveLength(1);
            expect(detail.createdTests[0]).toMatchObject({
                testCase: { id: assignment.testCaseId, slug: "guest-check" },
                description: "A guest can complete checkout without signing in and reach order confirmation.",
                plan: "Complete checkout",
                generation: { id: generation.id, status: "success", verdict: "success" },
                run: { id: run.id, status: "success" },
            });
        });

        test("uses the final refinement loop outcome instead of earlier failed attempts", async ({ harness }) => {
            const fixture = await createSnapshotDetailFixture(harness, { testNames: ["Checkout check"] });
            const assignment = fixture.assignments.checkout;
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

            const loop = await harness.db.refinementLoop.create({
                data: {
                    snapshotId: fixture.snapshotId,
                    triggeredBy: "diffs",
                    status: "converged",
                    startedAt: new Date("2026-01-01T10:00:00Z"),
                    finishedAt: new Date("2026-01-01T10:30:00Z"),
                    organizationId: harness.organizationId,
                },
            });
            const iterationOne = await createRefinementIteration(harness, loop.id, plan.id, 1, {
                startedAt: new Date("2026-01-01T10:00:00Z"),
                finishedAt: new Date("2026-01-01T10:10:00Z"),
            });
            const iterationTwo = await createRefinementIteration(harness, loop.id, plan.id, 2, {
                startedAt: new Date("2026-01-01T10:20:00Z"),
                finishedAt: new Date("2026-01-01T10:30:00Z"),
            });

            const firstGeneration = await createSuccessfulGeneration(
                harness,
                fixture.snapshotId,
                plan.id,
                new Date("2026-01-01T10:02:00Z"),
            );
            const failedRun = await createRun(harness, assignment.id, "failed", new Date("2026-01-01T10:05:00Z"), {
                planId: plan.id,
            });
            await harness.db.runReview.create({
                data: {
                    runId: failedRun.id,
                    status: "completed",
                    verdict: "application_bug",
                    reasoning: "Checkout failed before the fix.",
                    organizationId: harness.organizationId,
                },
            });

            await createSuccessfulGeneration(harness, fixture.snapshotId, plan.id, new Date("2026-01-01T10:22:00Z"));
            const passingRun = await createRun(harness, assignment.id, "success", new Date("2026-01-01T10:25:00Z"), {
                planId: plan.id,
            });

            expect(iterationOne.number).toBe(1);
            expect(iterationTwo.number).toBe(2);
            expect(firstGeneration.status).toBe("success");

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.healthCounts).toMatchObject({
                passing: 1,
                failing: 0,
                running: 0,
                totalTests: 1,
            });
            expect(detail.executedTests).toHaveLength(1);
            expect(detail.executedTests[0]).toMatchObject({
                runId: passingRun.id,
                status: "success",
                finalOutcome: "passed",
            });
        });

        test("summary reads 'No runs' (neutral), not unhealthy, for engine quarantine with no runs and no bugs", async ({
            harness,
        }) => {
            // Assigned tests, an engine-limitation quarantine, zero runs, zero open bugs. Must not
            // present as "unhealthy · 0 bugs".
            const fixture = await createSnapshotDetailFixture(harness);

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.summary.executionState).toBe("not_started");
            expect(detail.summary.tone).toBe("neutral");
            expect(detail.summary.label).toBe("No runs");
            expect(detail.summary.openBugCount).toBe(0);
            expect(detail.summary.quarantine.engine).toBe(1);
        });

        test("resolves to the last completed outcome when a terminated loop has a trailing pending iteration", async ({
            harness,
        }) => {
            const fixture = await createSnapshotDetailFixture(harness, { testNames: ["Healing check"] });
            const { plan } = await attachPlan(harness, fixture.assignments.healing);

            // Terminal `max_iterations` loop with a never-executed iteration #2 left in `pending`.
            // The outcome should reflect iteration #1's failure, not appear as still running.
            const loop = await harness.db.refinementLoop.create({
                data: {
                    snapshotId: fixture.snapshotId,
                    triggeredBy: "diffs",
                    status: "max_iterations",
                    startedAt: new Date("2026-01-01T10:00:00Z"),
                    finishedAt: new Date("2026-01-01T10:20:00Z"),
                    organizationId: harness.organizationId,
                },
            });
            await createRefinementIteration(harness, loop.id, plan.id, 1, {
                startedAt: new Date("2026-01-01T10:00:00Z"),
                finishedAt: new Date("2026-01-01T10:10:00Z"),
            });
            await createRefinementIteration(harness, loop.id, plan.id, 2, {
                startedAt: new Date("2026-01-01T10:20:00Z"),
                status: "pending",
            });

            // The only generation failed review and no replay ever ran.
            await createFailedGeneration(harness, fixture.snapshotId, plan.id, new Date("2026-01-01T10:05:00Z"));

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.executedTests).toHaveLength(1);
            expect(detail.executedTests[0]).toMatchObject({
                finalOutcome: "failed",
                runId: null,
            });
            expect(detail.executedTests[0]?.generationId).not.toBeNull();
            expect(detail.healthCounts).toMatchObject({ failing: 1, running: 0, passing: 0 });
        });

        test("surfaces a scenario_setup failure in a completed iteration as setup_failed", async ({ harness }) => {
            const fixture = await createSnapshotDetailFixture(harness, { testNames: ["Checkout check"] });
            const { plan } = await attachPlan(harness, fixture.assignments.checkout);

            const loop = await createRefinementLoop(harness, fixture.snapshotId);
            await createRefinementIteration(harness, loop.id, plan.id, 1, {
                startedAt: new Date("2026-01-01T10:00:00Z"),
                finishedAt: new Date("2026-01-01T10:10:00Z"),
            });
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

        // Documents the #995 boundary: a non-completed final iteration that still carries
        // RefinementIterationInput rows for the test case keeps masking the underlying
        // scenario_setup failure as unresolved/pending. This slice intentionally does not fix that.
        test("keeps a setup failure masked behind a dangling final iteration that carries inputs", async ({
            harness,
        }) => {
            const fixture = await createSnapshotDetailFixture(harness, { testNames: ["Checkout check"] });
            const { plan } = await attachPlan(harness, fixture.assignments.checkout);

            const loop = await createRefinementLoop(harness, fixture.snapshotId);
            await createRefinementIteration(harness, loop.id, plan.id, 1, {
                startedAt: new Date("2026-01-01T10:00:00Z"),
                finishedAt: new Date("2026-01-01T10:10:00Z"),
            });
            await createScenarioSetupFailedGeneration(
                harness,
                fixture.snapshotId,
                plan.id,
                new Date("2026-01-01T10:02:00Z"),
                "The staging environment never came up.",
            );
            // The dangling final iteration is still in-flight but carries an input for the same plan.
            await createRefinementIteration(harness, loop.id, plan.id, 2, {
                startedAt: new Date("2026-01-01T10:20:00Z"),
                status: "running",
            });

            const detail = await harness.request().branches.snapshotDetail({ snapshotId: fixture.snapshotId });

            expect(detail.healthCounts).toMatchObject({
                setupFailed: 0,
                failing: 0,
                passing: 0,
                running: 1,
                totalTests: 1,
            });
            expect(detail.executedTests).toHaveLength(1);
            expect(detail.executedTests[0]).toMatchObject({ finalOutcome: "unresolved", status: "pending" });
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

async function createRefinementLoop(harness: APITestHarness, snapshotId: string) {
    return harness.db.refinementLoop.create({
        data: {
            snapshotId,
            triggeredBy: "diffs",
            status: "running",
            startedAt: new Date("2026-01-01T10:00:00Z"),
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
    await harness.db.diffsJob.create({
        data: {
            snapshotId: branch.activeSnapshotId,
            status: "completed",
            organizationId: harness.organizationId,
        },
    });

    const folder = await harness.db.folder.create({
        data: {
            name: "Default",
            applicationId: application.id,
            organizationId: harness.organizationId,
        },
    });

    const names = input.testNames ?? ["Passing check", "Failing check", "Running check", "Quarantined check"];
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

    if (assignments.quarantined != null) {
        const issue = await harness.db.issue.create({
            data: {
                kind: "engine_limitation",
                severity: "low",
                title: "Known automation issue",
                description: "The test is intentionally quarantined.",
                snapshotId: branch.activeSnapshotId,
                organizationId: harness.organizationId,
            },
        });
        await harness.db.testCaseAssignment.update({
            where: { id: assignments.quarantined.id },
            data: { quarantineIssueId: issue.id },
        });
    }

    return {
        snapshotId: branch.activeSnapshotId,
        assignments,
    };
}

async function createRun(
    harness: APITestHarness,
    assignmentId: string,
    status: "pending" | "running" | "success" | "failed",
    at: Date,
    input: { planId?: string } = {},
) {
    return harness.db.run.create({
        data: {
            assignmentId,
            planId: input.planId,
            status,
            startedAt: at,
            createdAt: at,
            organizationId: harness.organizationId,
        },
    });
}

async function createRefinementIteration(
    harness: APITestHarness,
    loopId: string,
    planId: string,
    number: number,
    input: { startedAt: Date; finishedAt?: Date; status?: "pending" | "running" | "completed" },
) {
    const iteration = await harness.db.refinementIteration.create({
        data: {
            loopId,
            number,
            status: input.status ?? "completed",
            startedAt: input.startedAt,
            finishedAt: input.finishedAt,
        },
    });
    await harness.db.refinementIterationInput.create({
        data: {
            iterationId: iteration.id,
            planId,
            createdAt: input.startedAt,
        },
    });
    return iteration;
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
