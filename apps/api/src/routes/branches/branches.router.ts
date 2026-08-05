import { z } from "zod";
import { protectedProcedure, router } from "../../trpc";

export const branchesRouter = router({
    list: protectedProcedure
        .input(
            z.object({
                applicationId: z.string(),
                state: z.enum(["open", "closed", "merged"]).default("open"),
                page: z.number().int().min(1).default(1),
            }),
        )
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.listBranches(input.applicationId, organizationId, input.state, input.page),
        ),

    // Name + test count for every open branch, for the Tests page's branch picker. Two cheap queries and no
    // per-row aggregates, so unlike `list` it is not paged - a picker that hides options is worse than a long one.
    names: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.listBranchNames(input.applicationId, organizationId),
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
                // The created-tests generation/run inspector is only rendered on the single-checkpoint
                // page. Callers that aggregate many snapshots (the PR overview card) leave it off to
                // avoid an N-snapshot fan-out of per-snapshot queries.
                includeCreatedTests: z.boolean().default(false),
            }),
        )
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getSnapshotDetail(input.snapshotId, organizationId, {
                includeCreatedTests: input.includeCreatedTests,
            }),
        ),

    snapshotReport: protectedProcedure
        .input(z.object({ snapshotId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getSnapshotReport(input.snapshotId, organizationId),
        ),

    // The authoritative analysis report (merged pipeline's findings + signed media) for the snapshot page. The
    // page gates the new authoritative layout on this resolving non-null; returns null otherwise. User-facing.
    analysisReport: protectedProcedure
        .input(z.object({ snapshotId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getAnalysisReportData(input.snapshotId, organizationId),
        ),

    // The authoritative `AnalysisJob` lifecycle for a snapshot (null for a diffs snapshot). The PR page reads this
    // to identify an authoritative snapshot before its report exists and to show the run's status as a fallback
    // while findings are still being produced. User-facing.
    analysisJob: protectedProcedure
        .input(z.object({ snapshotId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getAnalysisJobStatus(input.snapshotId, organizationId),
        ),

    // The branch's analysis issues (all statuses, branch-scoped) for the PR page: the open ones drive the
    // issues-first list, and resolved ones let the report prose's `issue:` tokens link them. User-facing; returns
    // an empty list for a branch with no issues (or a diffs branch).
    analysisIssues: protectedProcedure
        .input(z.object({ branchId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getAnalysisIssues(input.branchId, organizationId),
        ),

    // Everything still unresolved on the application's main branch, in one normalized shape: analysis issues once
    // main has run the merged pipeline, the deprecated `Bug` rows until then. The fork is decided server-side, so
    // the overview rail and the main-branch page's problem list read this and never re-derive it. User-facing.
    mainOpenProblems: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getMainOpenProblems(input.applicationId, organizationId),
        ),

    // One analysis issue in full (narrative + signed evidence + cross-snapshot finding instances) for the PR-level
    // issue-detail page. User-facing; returns null for an unknown/malformed issue.
    analysisIssueDetail: protectedProcedure
        .input(z.object({ issueId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getAnalysisIssueDetail(input.issueId, organizationId),
        ),

    // The per-job issue-set changes (opened / carried-forward / resolved) for a snapshot's analysis run, for the
    // snapshot per-job view. User-facing; empty groups for a diffs snapshot.
    analysisSnapshotIssueChanges: protectedProcedure
        .input(z.object({ snapshotId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getAnalysisSnapshotIssueChanges(input.snapshotId, organizationId),
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
});
