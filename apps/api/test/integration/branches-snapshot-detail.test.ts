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
    },
});

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
    const assignments: Record<string, { id: string }> = {};
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
        assignments[slug.replace("-check", "")] = { id: assignment.id };
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
) {
    return harness.db.run.create({
        data: {
            assignmentId,
            status,
            startedAt: at,
            createdAt: at,
            organizationId: harness.organizationId,
        },
    });
}
