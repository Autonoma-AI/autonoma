import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedAnalysisFindings } from "../seed-analysis-findings";

apiTestSuite({
    name: "branches.analysisRun",
    cases: (test) => {
        test("rows carry status, timing and the checkpoint's change kind; removed tests get stub rows", async ({
            harness,
        }) => {
            const { snapshotId, prevSnapshotId, applicationId } = await createAuthoritativeSnapshot(harness);
            const findingFor = await seedAnalysisFindings(harness.db, snapshotId, [
                { slug: "edited-test", category: "client_bug", headline: "Broke after the rewrite" },
                { slug: "created-test", category: "passed" },
            ]);

            // Assignments drive the change kinds: `edited-test` changes plan between snapshots, `created-test`
            // exists only in the current one, and `removed-test` exists only in the previous one (no finding).
            const editedId = await testCaseIdOf(harness, applicationId, "edited-test");
            const createdId = await testCaseIdOf(harness, applicationId, "created-test");
            const removedId = await createTestCase(harness, applicationId, "removed-test");
            await assign(harness, prevSnapshotId, editedId, "edited-test old plan");
            await assign(harness, snapshotId, editedId, "edited-test new plan");
            await assign(harness, snapshotId, createdId, "created-test plan");
            await assign(harness, prevSnapshotId, removedId, "removed-test plan");

            const view = await harness.request().branches.analysisRun({ snapshotId });

            expect(view).not.toBeNull();
            const edited = view?.findings.find((row) => row.findingId === findingFor("edited-test"));
            const created = view?.findings.find((row) => row.findingId === findingFor("created-test"));
            expect(edited?.change).toBe("edited");
            expect(created?.change).toBe("created");
            // The seeded generations are terminal, so both timing endpoints are present.
            expect(edited?.generationStatus).toBe("success");
            expect(edited?.startedAt).toBeInstanceOf(Date);
            expect(edited?.completedAt).toBeInstanceOf(Date);

            expect(view?.removedTests).toHaveLength(1);
            expect(view?.removedTests[0]?.testCase.id).toBe(removedId);
            expect(view?.removedTests[0]?.previousPlan).toBe("removed-test plan");
        });

        test("a checkpoint with no suite changes has no chips and no stub rows", async ({ harness }) => {
            const { snapshotId } = await createAuthoritativeSnapshot(harness);
            await seedAnalysisFindings(harness.db, snapshotId, [{ slug: "untouched-test", category: "passed" }]);

            const view = await harness.request().branches.analysisRun({ snapshotId });

            expect(view?.findings).toHaveLength(1);
            expect(view?.findings[0]?.change).toBeUndefined();
            expect(view?.removedTests).toEqual([]);
        });
    },
});

/** An active snapshot with an AnalysisJob and a previous snapshot to diff assignments against. */
async function createAuthoritativeSnapshot(
    harness: APITestHarness,
): Promise<{ snapshotId: string; prevSnapshotId: string; applicationId: string }> {
    const application = await harness.services.applications.createApplication({
        name: `Analysis Run ${crypto.randomUUID()}`,
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

    const prev = await harness.db.branchSnapshot.create({
        data: { branchId: branch.id, status: "superseded", source: "MANUAL" },
        select: { id: true },
    });
    await harness.db.branchSnapshot.update({
        where: { id: branch.activeSnapshotId },
        data: { status: "active", baseSha: "base-sha", headSha: "head-sha", prevSnapshotId: prev.id },
    });
    await harness.db.analysisJob.create({
        data: { snapshotId: branch.activeSnapshotId, status: "running", organizationId: harness.organizationId },
    });

    return { snapshotId: branch.activeSnapshotId, prevSnapshotId: prev.id, applicationId: application.id };
}

async function testCaseIdOf(harness: APITestHarness, applicationId: string, slug: string): Promise<string> {
    const testCase = await harness.db.testCase.findUniqueOrThrow({
        where: { applicationId_slug: { applicationId, slug } },
        select: { id: true },
    });
    return testCase.id;
}

async function createTestCase(harness: APITestHarness, applicationId: string, slug: string): Promise<string> {
    const folder = await harness.db.folder.create({
        data: { name: `Flow ${slug}`, applicationId, organizationId: harness.organizationId },
    });
    const testCase = await harness.db.testCase.create({
        data: { name: slug, slug, applicationId, folderId: folder.id, organizationId: harness.organizationId },
        select: { id: true },
    });
    return testCase.id;
}

/** Assign the test to the snapshot under a fresh plan holding `prompt` - each plan id is unique, so a
 * re-assignment under a new prompt reads as an `updated` suite change. */
async function assign(harness: APITestHarness, snapshotId: string, testCaseId: string, prompt: string): Promise<void> {
    const plan = await harness.db.testPlan.create({
        data: { testCaseId, prompt, organizationId: harness.organizationId },
        select: { id: true },
    });
    await harness.db.testCaseAssignment.create({
        data: { snapshotId, testCaseId, planId: plan.id },
    });
}
