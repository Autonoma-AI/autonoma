import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

// The reasoning in the snapshot report and the diffs timeline comes from iteration
// 1 of the snapshot's refinement loop, never from the diffs job column.
apiTestSuite({
    name: "branches first iteration reasoning",
    cases: (test) => {
        test("sources first-iteration reasoning from refinement iteration 1, ignoring the diffs job column", async ({
            harness,
        }) => {
            const fixture = await createFixture(harness);

            // The diffs job column is never read; a value here must not surface in the readers.
            await harness.db.diffsJob.update({
                where: { snapshotId: fixture.snapshotId },
                data: { resolutionReasoning: "Diffs job column value - must be ignored." },
            });

            const loop = await harness.db.refinementLoop.create({
                data: {
                    snapshotId: fixture.snapshotId,
                    triggeredBy: "diffs",
                    status: "converged",
                    organizationId: harness.organizationId,
                },
            });
            await createIteration(
                harness,
                loop.id,
                fixture.planId,
                1,
                "Iteration 1 healed the affected checkout test.",
            );
            await createIteration(harness, loop.id, fixture.planId, 2, "Iteration 2 refined the regenerated plan.");

            const [detail, report] = await Promise.all([
                harness
                    .request()
                    .branches.snapshotDetail({ snapshotId: fixture.snapshotId, includeRefinementLoop: true }),
                harness.request().branches.snapshotReport({ snapshotId: fixture.snapshotId }),
            ]);

            expect(detail.diffsJob.firstIterationReasoning).toBe("Iteration 1 healed the affected checkout test.");
            expect(report.firstIterationReasoning).toBe("Iteration 1 healed the affected checkout test.");
        });

        test("leaves first-iteration reasoning undefined when the snapshot has no refinement loop", async ({
            harness,
        }) => {
            const fixture = await createFixture(harness);

            // With no refinement loop there is no first-iteration reasoning, even when the column is set.
            await harness.db.diffsJob.update({
                where: { snapshotId: fixture.snapshotId },
                data: { resolutionReasoning: "Diffs job column value - must be ignored." },
            });

            const [detail, report] = await Promise.all([
                harness
                    .request()
                    .branches.snapshotDetail({ snapshotId: fixture.snapshotId, includeRefinementLoop: true }),
                harness.request().branches.snapshotReport({ snapshotId: fixture.snapshotId }),
            ]);

            expect(detail.diffsJob.firstIterationReasoning).toBeUndefined();
            expect(report.firstIterationReasoning).toBeUndefined();
        });
    },
});

async function createFixture(harness: APITestHarness) {
    const application = await harness.services.applications.createApplication({
        name: `Resolution Reasoning ${crypto.randomUUID()}`,
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
        data: { name: "Default", applicationId: application.id, organizationId: harness.organizationId },
    });
    const testCase = await harness.db.testCase.create({
        data: {
            name: "Checkout check",
            slug: "checkout-check",
            applicationId: application.id,
            folderId: folder.id,
            organizationId: harness.organizationId,
        },
    });
    const plan = await harness.db.testPlan.create({
        data: { testCaseId: testCase.id, prompt: "Complete checkout", organizationId: harness.organizationId },
    });
    await harness.db.testCaseAssignment.create({
        data: { snapshotId: branch.activeSnapshotId, testCaseId: testCase.id, planId: plan.id },
    });

    return { snapshotId: branch.activeSnapshotId, planId: plan.id };
}

async function createIteration(
    harness: APITestHarness,
    loopId: string,
    planId: string,
    number: number,
    reasoning: string,
) {
    const iteration = await harness.db.refinementIteration.create({
        data: { loopId, number, status: "completed", reasoning },
    });
    await harness.db.refinementIterationInput.create({
        data: { iterationId: iteration.id, planId },
    });
    return iteration;
}
