import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

apiTestSuite({
    name: "branches.analysisJob",
    cases: (test) => {
        test("returns the analysis job lifecycle for an authoritative snapshot", async ({ harness }) => {
            const snapshotId = await createSnapshot(harness);
            const startedAt = new Date("2026-01-01T11:20:00.000Z");
            await harness.db.analysisJob.create({
                data: { snapshotId, status: "running", startedAt, organizationId: harness.organizationId },
            });

            const job = await harness.request().branches.analysisJob({ snapshotId });

            expect(job).not.toBeNull();
            expect(job?.status).toBe("running");
            expect(job?.startedAt).toEqual(startedAt);
            expect(job?.completedAt).toBeUndefined();
            expect(job?.failureReason).toBeUndefined();
        });

        test("returns null for a snapshot with no analysis job (a diffs snapshot)", async ({ harness }) => {
            const snapshotId = await createSnapshot(harness);

            const job = await harness.request().branches.analysisJob({ snapshotId });

            expect(job).toBeNull();
        });
    },
});

/** An active snapshot with no status job of its own - the caller adds an AnalysisJob when it wants one. */
async function createSnapshot(harness: APITestHarness): Promise<string> {
    const application = await harness.services.applications.createApplication({
        name: `Analysis Job ${crypto.randomUUID()}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/default-file.png",
    });
    const branch = await harness.db.branch.findFirstOrThrow({
        where: { applicationId: application.id },
        select: { activeSnapshotId: true },
    });
    if (branch.activeSnapshotId == null) throw new Error("Expected createApplication to create an active snapshot");

    await harness.db.branchSnapshot.update({
        where: { id: branch.activeSnapshotId },
        data: { status: "active", baseSha: "base-sha", headSha: "head-sha" },
    });

    return branch.activeSnapshotId;
}
