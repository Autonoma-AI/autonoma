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
