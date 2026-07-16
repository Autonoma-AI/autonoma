import { z } from "zod";
import { internalEmailProcedure, protectedProcedure, router } from "../../trpc";

export const branchesRouter = router({
    list: protectedProcedure
        .input(
            z.object({
                applicationId: z.string(),
                state: z.enum(["open", "closed", "merged"]).default("open"),
            }),
        )
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.listBranches(input.applicationId, organizationId, input.state),
        ),

    detail: protectedProcedure
        .input(z.object({ branchId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getBranch(input.branchId, organizationId),
        ),

    detailByName: protectedProcedure
        .input(z.object({ applicationId: z.string(), branchName: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getBranchByName(input.applicationId, input.branchName, organizationId),
        ),

    detailByPr: protectedProcedure
        .input(z.object({ applicationId: z.string(), prNumber: z.number().int().positive() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getBranchByPr(input.applicationId, input.prNumber, organizationId),
        ),

    pipelineStatusByBranchId: protectedProcedure
        .input(z.object({ applicationId: z.string(), branchId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.prPipelineStatusByBranchId(input.applicationId, input.branchId, organizationId),
        ),

    snapshotHistory: protectedProcedure
        .input(z.object({ branchId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.listSnapshots(input.branchId, organizationId),
        ),

    snapshotDetail: protectedProcedure
        .input(
            z.object({
                snapshotId: z.string(),
                // The Temporal workflow lookup (external call) and refinement loop query are only
                // rendered on the single-checkpoint page. Callers that aggregate many snapshots (the
                // PR overview card) leave these off to avoid an N-snapshot fan-out of expensive work.
                includeWorkflow: z.boolean().default(false),
                includeRefinementLoop: z.boolean().default(false),
            }),
        )
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getSnapshotDetail(input.snapshotId, organizationId, {
                includeWorkflow: input.includeWorkflow,
                includeRefinementLoop: input.includeRefinementLoop,
            }),
        ),

    snapshotReport: protectedProcedure
        .input(z.object({ snapshotId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getSnapshotReport(input.snapshotId, organizationId),
        ),

    // The shadow investigation agent's report (a freshly-signed S3 URL), for comparing against the deployed
    // agent. Internal-only: gated to @autonoma.app users. Returns undefined when no shadow report exists.
    investigationReport: internalEmailProcedure
        .input(z.object({ snapshotId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getInvestigationReport(input.snapshotId, organizationId),
        ),

    // The structured investigation report (findings + signed media) for the in-app "View investigation" page.
    // Internal-only, gated to @autonoma.app users; returns undefined when no rich report exists for the snapshot.
    investigationReportData: internalEmailProcedure
        .input(z.object({ snapshotId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getInvestigationReportData(input.snapshotId, organizationId),
        ),

    // Batched investigation presence for the PR-list entry points (Home + PR list). Internal-only, gated to
    // @autonoma.app users; returns one entry per PR-snapshot that has a report (keyed by the PR snapshot id).
    investigationReportsForSnapshots: internalEmailProcedure
        .input(z.object({ snapshotIds: z.array(z.string()) }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getInvestigationReportsForSnapshots(input.snapshotIds, organizationId),
        ),

    activeSnapshot: protectedProcedure
        .input(z.object({ branchId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getActiveSnapshot(input.branchId, organizationId),
        ),

    testSuiteChangesByPr: protectedProcedure
        .input(z.object({ branchId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getTestSuiteChangesByPr(input.branchId, organizationId),
        ),

    delete: protectedProcedure
        .input(z.object({ branchId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.branches.deleteBranch(input.branchId, organizationId),
        ),
});
