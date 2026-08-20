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

    // The live view of an analysis run for the checkpoint page's staged progress: the run's findings (born at
    // selection, unjudged rows included) with each test's latest generation status, plus the selection summary.
    // Served mid-run, before the report settles; null for a diffs snapshot. User-facing.
    analysisRun: protectedProcedure
        .input(z.object({ snapshotId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getAnalysisRun(input.snapshotId, organizationId),
        ),

    // One finding in full for the checkpoint drawer: iteration history, the selected iteration's verdict story,
    // the generation behind it with live-persisted steps, and the plan with the PR's change to it. Served
    // mid-run and pollable; `iteration` selects an earlier self-heal attempt. User-facing; debug/observability
    // fields are admin-only and gated server-side.
    analysisFindingDetail: protectedProcedure
        .input(z.object({ findingId: z.string(), iteration: z.number().int().positive().optional() }))
        .query(({ ctx: { services, organizationId, user }, input }) =>
            services.branches.getAnalysisFindingDetail(input.findingId, organizationId, {
                iteration: input.iteration,
                isAdmin: user.role === "admin",
            }),
        ),

    // The branch's analysis issues (all statuses, branch-scoped) for the PR page: the open ones drive the
    // issues-first list, and resolved ones let the report prose's `issue:` tokens link them. User-facing; returns
    // an empty list for a branch with no issues (or a diffs branch).
    analysisIssues: protectedProcedure
        .input(z.object({ branchId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getAnalysisIssues(input.branchId, organizationId),
        ),

    // The open analysis issues on the application's main branch, ordered bugs-first then by descending severity.
    // The overview rail and the main-branch page's problem list both read this and never re-derive the ordering.
    // User-facing; returns an empty list for an application whose main branch has nothing unresolved.
    mainOpenProblems: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getMainOpenProblems(input.applicationId, organizationId),
        ),

    // The PR's analysis exactly as the MCP `get_analysis` tool serves it: the run header (verdict, headline, flows,
    // report prose, impact reasoning) plus every open issue of every kind with its behavior claim, grounded cause,
    // covering tests and signed media. User-facing.
    analysisForPr: protectedProcedure
        .input(z.object({ applicationId: z.string(), prNumber: z.number().int().positive() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.branches.getAnalysisForPr(input.applicationId, input.prNumber, organizationId),
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
