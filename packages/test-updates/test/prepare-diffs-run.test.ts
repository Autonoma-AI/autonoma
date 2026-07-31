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

        // Dedupe: two triggers for the SAME head (e.g. an activation label added while a /start analysis comment
        // is mid-run) must not start a second run. The second prepare attaches to the pending snapshot the first
        // created rather than superseding it.
        test("attaches to the in-flight run for the same head instead of starting a duplicate", async ({ harness }) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 13 });
            const workflows = fakeWorkflows();
            const preparer = preparerFor(harness.db, workflows);

            const first = await preparer.prepare({
                branchId,
                organizationId,
                headSha: "head-1",
                baseSha: "base-1",
                url: "https://preview.example.com",
                requested: true,
            });
            expect(first.skipped).toBe(false);
            if (first.skipped) return;

            const second = await preparer.prepare({
                branchId,
                organizationId,
                headSha: "head-1",
                baseSha: "base-1",
                url: "https://preview.example.com",
                requested: true,
            });

            // The second call attaches to the same snapshot - no new snapshot, and the analysis workflow was
            // triggered exactly once.
            expect(second.skipped).toBe(false);
            if (second.skipped) return;
            expect(second.snapshotId).toBe(first.snapshotId);
            expect(workflows.triggerAnalysis).toHaveBeenCalledTimes(1);
            expect(workflows.cancelAnalysis).not.toHaveBeenCalled();
            const snapshots = await harness.db.branchSnapshot.findMany({ where: { branchId } });
            expect(snapshots).toHaveLength(1);
        });

        // Dedupe across trigger kinds: a preview-ready auto-run-on-ready that fires just after a `/start analysis`
        // created a pending snapshot for the same head must attach to it, not supersede the requested run.
        test("an auto-run-on-ready attaches to an in-flight requested run for the same head", async ({ harness }) => {
            const organizationId = await harness.createOrg();
            await harness.db.organizationSettings.create({ data: { organizationId, activationEnabled: true } });
            const applicationId = await harness.createApp(organizationId);
            await harness.db.applicationTriggerConfig.create({
                data: { applicationId, autoRunOnReadyForReview: true },
            });
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 14 });
            const workflows = fakeWorkflows();
            const preparer = preparerFor(harness.db, workflows);

            // A `/start analysis` (requested) creates the in-flight snapshot for the head.
            const requested = await preparer.prepare({
                branchId,
                organizationId,
                headSha: "head-1",
                baseSha: "base-1",
                url: "https://preview.example.com",
                requested: true,
            });
            expect(requested.skipped).toBe(false);
            if (requested.skipped) return;

            // The preview-ready auto-run (NOT requested) for the same head attaches instead of superseding.
            const autoRun = await preparer.prepare({
                branchId,
                organizationId,
                headSha: "head-1",
                baseSha: "base-1",
                url: "https://preview.example.com",
            });

            expect(autoRun.skipped).toBe(false);
            if (autoRun.skipped) return;
            expect(autoRun.snapshotId).toBe(requested.snapshotId);
            expect(workflows.triggerAnalysis).toHaveBeenCalledTimes(1);
            expect(workflows.cancelAnalysis).not.toHaveBeenCalled();
            expect(await harness.db.branchSnapshot.findMany({ where: { branchId } })).toHaveLength(1);
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

        // Activation: an automatic (preview-ready) run is suppressed, UNLESS the repo opted into auto-run-on-ready
        // - which is how the ready-for-review trigger fires (at the moment the preview is actually live).
        test("under activation, an automatic run is suppressed unless the repo opted into auto-run-on-ready", async ({
            harness,
        }) => {
            const organizationId = await harness.createOrg();
            await harness.db.organizationSettings.create({
                data: { organizationId, activationEnabled: true },
            });

            // Opted out (no trigger config): the automatic run is suppressed.
            const suppressedApp = await harness.createApp(organizationId);
            const suppressedBranch = await harness.createBranch(organizationId, suppressedApp, { prNumber: 20 });
            const workflows = fakeWorkflows();
            const suppressed = await preparerFor(harness.db, workflows).prepare({
                branchId: suppressedBranch,
                organizationId,
                headSha: "head-1",
                baseSha: "base-1",
                url: "https://preview.example.com",
            });
            expect(suppressed.skipped).toBe(true);
            expect(workflows.triggerAnalysis).not.toHaveBeenCalled();

            // Opted into auto-run-on-ready: the same automatic run proceeds.
            const autoRunApp = await harness.createApp(organizationId);
            await harness.db.applicationTriggerConfig.create({
                data: { applicationId: autoRunApp, autoRunOnReadyForReview: true },
            });
            const autoRunBranch = await harness.createBranch(organizationId, autoRunApp, { prNumber: 21 });
            const proceeded = await preparerFor(harness.db, workflows).prepare({
                branchId: autoRunBranch,
                organizationId,
                headSha: "head-1",
                baseSha: "base-1",
                url: "https://preview.example.com",
            });
            expect(proceeded.skipped).toBe(false);
            if (proceeded.skipped) return;
            expect(workflows.triggerAnalysis).toHaveBeenCalledWith({ snapshotId: proceeded.snapshotId });
        });
    },
});
