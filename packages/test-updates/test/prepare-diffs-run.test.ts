import type { PrismaClient } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import type { PipelineWorkflows } from "@autonoma/workflow";
import { expect, vi } from "vitest";
import { DiffsRunPreparer } from "../src/queries/prepare-diffs-run";
import { testUpdateSuite } from "./harness";

function fakeWorkflows(): PipelineWorkflows {
    return {
        cancelDiffs: vi.fn().mockResolvedValue(undefined),
        triggerInvestigation: vi.fn().mockResolvedValue(undefined),
        cancelInvestigation: vi.fn().mockResolvedValue(undefined),
        triggerAnalysis: vi.fn().mockResolvedValue(undefined),
        cancelAnalysis: vi.fn().mockResolvedValue(undefined),
    };
}

function preparerFor(db: PrismaClient, workflows: PipelineWorkflows): DiffsRunPreparer {
    return new DiffsRunPreparer({ db, logger, workflows });
}

testUpdateSuite({
    name: "DiffsRunPreparer",
    cases: (test) => {
        test("starts the analysis pipeline, and only that, for any org", async ({ harness }) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 7 });
            const workflows = fakeWorkflows();

            const result = await preparerFor(harness.db, workflows).prepare({
                branchId,
                organizationId,
                headSha: "head-1",
                baseSha: "base-1",
                url: "https://preview.example.com",
            });

            expect(result.skipped).toBe(false);
            if (result.skipped) return;
            expect(
                await harness.db.analysisJob.findUnique({ where: { snapshotId: result.snapshotId } }),
            ).not.toBeNull();
            expect(workflows.triggerAnalysis).toHaveBeenCalledWith({ snapshotId: result.snapshotId });
            // No diffs job and no investigation shadow: neither has a trigger any more.
            expect(await harness.db.diffsJob.findUnique({ where: { snapshotId: result.snapshotId } })).toBeNull();
            expect(workflows.triggerInvestigation).not.toHaveBeenCalled();
            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: result.snapshotId } });
            expect(snapshot.investigationSnapshotId).toBeNull();
        });

        // The drain shim. A branch whose pending snapshot came from a pre-cutover diffs run must still be
        // unblocked by the next push - a stranded diffs workflow never self-reaps, so nothing else closes it out.
        test("supersedes a pre-cutover diffs run and its investigation twin", async ({ harness }) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 11 });
            const workflows = fakeWorkflows();
            const preparer = preparerFor(harness.db, workflows);

            const stale = await preparer.prepare({
                branchId,
                organizationId,
                headSha: "head-old",
                baseSha: "base-old",
                url: "https://preview.example.com",
            });
            expect(stale.skipped).toBe(false);
            if (stale.skipped) return;

            // Reshape the pending snapshot into what a pre-cutover run left behind: a DiffsJob instead of an
            // AnalysisJob, plus a paired investigation twin.
            await harness.db.analysisJob.delete({ where: { snapshotId: stale.snapshotId } });
            await harness.db.diffsJob.create({
                data: { snapshotId: stale.snapshotId, organizationId, status: "pending" },
            });
            const twin = await harness.db.branchSnapshot.create({
                data: { branchId, source: "WEBHOOK", status: "processing" },
            });
            await harness.db.branchSnapshot.update({
                where: { id: stale.snapshotId },
                data: { investigationSnapshotId: twin.id },
            });

            const fresh = await preparer.prepare({
                branchId,
                organizationId,
                headSha: "head-new",
                baseSha: "base-new",
                url: "https://preview-v2.example.com",
            });

            expect(fresh.skipped).toBe(false);
            if (fresh.skipped) return;
            expect(fresh.snapshotId).not.toBe(stale.snapshotId);

            const supersededJob = await harness.db.diffsJob.findUniqueOrThrow({
                where: { snapshotId: stale.snapshotId },
            });
            expect(supersededJob.status).toBe("failed");
            expect(supersededJob.failureReason).toContain("Superseded");
            expect(supersededJob.completedAt).not.toBeNull();
            expect(workflows.cancelDiffs).toHaveBeenCalledWith(stale.snapshotId);

            const cancelledTwin = await harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: twin.id } });
            expect(cancelledTwin.status).toBe("cancelled");
            expect(workflows.cancelInvestigation).toHaveBeenCalledWith(twin.id);

            // And the replacement run is an analysis run.
            expect(await harness.db.analysisJob.findUnique({ where: { snapshotId: fresh.snapshotId } })).not.toBeNull();
            expect(workflows.triggerAnalysis).toHaveBeenCalledWith({ snapshotId: fresh.snapshotId });
        });

        test("skips a re-delivered signal for an already-analyzed head", async ({ harness }) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 12 });
            const workflows = fakeWorkflows();

            const result = await preparerFor(harness.db, workflows).prepare({
                branchId,
                organizationId,
                headSha: "same-sha",
                baseSha: "same-sha",
                url: "https://preview.example.com",
            });

            expect(result.skipped).toBe(true);
            expect(workflows.triggerAnalysis).not.toHaveBeenCalled();
        });
    },
});
