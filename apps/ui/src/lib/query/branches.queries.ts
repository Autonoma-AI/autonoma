import { type QueryClient, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import type { RouterOutputs } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

export type PullRequestStateFilter = "open" | "closed" | "merged";

/** The AnalysisJob lifecycle status, mirrored from the router output (the db enum is not importable here). */
export type AnalysisJobStatus = NonNullable<RouterOutputs["branches"]["analysisJob"]>["status"];

/**
 * The authoritative analysis report (the Reporter's prose + summary, and this run's findings) for a snapshot,
 * `null` for a diffs snapshot. A suspense query prefetched in the route loaders.
 *
 * Pass the run's `jobStatus` to keep the query polling while a run that has not produced a report yet is still
 * expected to - `running`, or `completed` but not yet observed (settlement writes the report before it flips the
 * job, so the completed-with-no-report window is transient and this closes it). A `failed` run never produces a
 * report and a diffs snapshot has no job, so both settle to no polling. Content-only callers (finding detail, the
 * changes list) omit `jobStatus` and never poll - they render a report a page above has already settled.
 */
export function useAnalysisReport(snapshotId: string, opts?: { jobStatus?: AnalysisJobStatus }) {
    const jobStatus = opts?.jobStatus;
    return useSuspenseQuery({
        ...trpc.branches.analysisReport.queryOptions({ snapshotId }),
        refetchInterval: (query) =>
            query.state.data == null && jobStatus != null && jobStatus !== "failed" ? 5000 : false,
        refetchIntervalInBackground: true,
    });
}

/** True when the snapshot has an authoritative analysis report (drives the authoritative changes-detail layout). */
export function useIsAuthoritativeSnapshot(snapshotId: string): boolean {
    const { data } = useAnalysisReport(snapshotId);
    return data != null;
}

/** Returns the report so a loader can chain the branch-scoped reads that need its `branchId`. */
export async function ensureAnalysisReportData(queryClient: QueryClient, snapshotId: string) {
    return await ensureAPIQueryData(queryClient, trpc.branches.analysisReport.queryOptions({ snapshotId }));
}

/**
 * The authoritative `AnalysisJob` lifecycle for a snapshot (null for a diffs snapshot). Presence identifies an
 * authoritative PR snapshot before any report exists, so the PR page can branch to the new layout and show the
 * run's status while findings are still being produced. Polls while the job is running so a terminal transition
 * (completed/failed) is reflected without a manual reload.
 */
export function useAnalysisJob(snapshotId: string) {
    return useSuspenseQuery({
        ...trpc.branches.analysisJob.queryOptions({ snapshotId }),
        refetchInterval: (query) => (query.state.data?.status === "running" ? 5000 : false),
        refetchIntervalInBackground: true,
    });
}

export async function ensureAnalysisJobData(queryClient: QueryClient, snapshotId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.analysisJob.queryOptions({ snapshotId }));
}

/**
 * The branch's analysis issues (all statuses, branch-scoped) for the PR page. The open ones drive the
 * issues-first list + verdict headline; resolved ones are included so the report prose's `issue:` tokens can link
 * them. A suspense query; empty for a branch with no issues. Only rendered once the run's report has landed (the
 * job is terminal by then), so it does not poll - the report query drives the page's liveness.
 */
export function useAnalysisIssues(branchId: string) {
    return useSuspenseQuery(trpc.branches.analysisIssues.queryOptions({ branchId }));
}

export async function ensureAnalysisIssuesData(queryClient: QueryClient, branchId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.analysisIssues.queryOptions({ branchId }));
}

/**
 * The open issues on the application's main branch, already ordered by the API. Every "what is broken on main"
 * surface reads this one query, so the overview rail and the main-branch page's problem list cannot disagree.
 */
export function useMainOpenProblems(applicationId: string) {
    return useSuspenseQuery(trpc.branches.mainOpenProblems.queryOptions({ applicationId }));
}

export async function ensureMainOpenProblemsData(queryClient: QueryClient, applicationId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.mainOpenProblems.queryOptions({ applicationId }));
}

/**
 * One analysis issue in full (narrative + signed evidence + cross-snapshot finding instances) for the PR-level
 * issue-detail page. A plain (non-suspense) query because the value is legitimately `null` for an unknown or
 * malformed issue - the page renders a graceful not-found for that, which useSuspenseQuery cannot express.
 */
export function useAnalysisIssueDetail(issueId: string) {
    return useQuery(trpc.branches.analysisIssueDetail.queryOptions({ issueId }));
}

export async function ensureAnalysisIssueDetailData(queryClient: QueryClient, issueId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.analysisIssueDetail.queryOptions({ issueId }));
}

/**
 * The per-job issue-set changes (opened / carried-forward / resolved) for a snapshot's analysis run, for the
 * snapshot per-job view. A suspense query; empty groups for a diffs snapshot. Keyed by snapshotId, so the route
 * loader prefetches it in the main batch (see `ensureAnalysisSnapshotIssueChangesData`) and the section paints at
 * mount instead of firing a third serial round-trip behind its Suspense boundary.
 */
export function useAnalysisSnapshotIssueChanges(snapshotId: string) {
    return useSuspenseQuery(trpc.branches.analysisSnapshotIssueChanges.queryOptions({ snapshotId }));
}

export async function ensureAnalysisSnapshotIssueChangesData(queryClient: QueryClient, snapshotId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.analysisSnapshotIssueChanges.queryOptions({ snapshotId }));
}

/**
 * Every open branch's name and test count, for the Tests page's branch picker. Its own query rather than a slice
 * of {@link useBranches}: the picker has no search box, so paging it would hide older branches with no way to
 * reach them, and it throws away the per-row health the paged list pays for.
 */
export function useBranchNames() {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(trpc.branches.names.queryOptions({ applicationId: currentApp.id }));
}

/** One page of pull requests. The page size and total live on the response - never re-derive them here. */
export function useBranches(state: PullRequestStateFilter = "open", page = 1) {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(trpc.branches.list.queryOptions({ applicationId: currentApp.id, state, page }));
}

export async function ensureBranchesData(
    queryClient: QueryClient,
    applicationId: string,
    state: PullRequestStateFilter = "open",
    page = 1,
) {
    await ensureAPIQueryData(queryClient, trpc.branches.list.queryOptions({ applicationId, state, page }));
}

export function useBranchDetail(applicationId: string, branchName: string) {
    return useSuspenseQuery(trpc.branches.detailByName.queryOptions({ applicationId, branchName }));
}

export function useBranchByPr(applicationId: string, prNumber: number) {
    return useSuspenseQuery(trpc.branches.detailByPr.queryOptions({ applicationId, prNumber }));
}

// The branch's rolled-up pipeline status (the same value the PR list shows), for the PR-page and
// main-branch headers. Not polled yet - liveness is deferred; it refreshes on load/navigation.
export function usePrPipelineStatus(applicationId: string, branchId: string) {
    return useSuspenseQuery(trpc.branches.pipelineStatusByBranchId.queryOptions({ applicationId, branchId }));
}

export async function ensurePrPipelineStatusData(queryClient: QueryClient, applicationId: string, branchId: string) {
    await ensureAPIQueryData(
        queryClient,
        trpc.branches.pipelineStatusByBranchId.queryOptions({ applicationId, branchId }),
    );
}

export async function ensureBranchByPrData(queryClient: QueryClient, applicationId: string, prNumber: number) {
    return await ensureAPIQueryData(queryClient, trpc.branches.detailByPr.queryOptions({ applicationId, prNumber }));
}

export async function ensureBranchData(queryClient: QueryClient, applicationId: string, branchName: string) {
    return await ensureAPIQueryData(
        queryClient,
        trpc.branches.detailByName.queryOptions({ applicationId, branchName }),
    );
}

export async function ensureBranchSnapshotId(
    queryClient: QueryClient,
    applicationId: string,
    branchName: string,
): Promise<string | undefined> {
    const data = await ensureBranchData(queryClient, applicationId, branchName);
    return data.activeSnapshot.id;
}

export function useSnapshotHistory(branchId: string) {
    return useSuspenseQuery(trpc.branches.snapshotHistory.queryOptions({ branchId }));
}

export async function ensureSnapshotHistoryData(queryClient: QueryClient, branchId: string) {
    return await ensureAPIQueryData(queryClient, trpc.branches.snapshotHistory.queryOptions({ branchId }));
}

type SnapshotHistoryEntry = RouterOutputs["branches"]["snapshotHistory"][number];

/** A branch's snapshot history sorted newest-first (the list is not guaranteed ordered by the server). */
export function sortSnapshotsNewestFirst(snapshots: SnapshotHistoryEntry[]): SnapshotHistoryEntry[] {
    return [...snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** The newest snapshot in a branch's history, or undefined for a PR with no snapshots yet. */
export function latestSnapshotOf(snapshots: SnapshotHistoryEntry[]): SnapshotHistoryEntry | undefined {
    return sortSnapshotsNewestFirst(snapshots)[0];
}

// A snapshot's liveness is polled by the analysis-report/job queries, not these - there is nothing on
// this payload that changes without those changing first.
//
// Two variants because the created-tests inspector costs an extra query per snapshot and only the
// single-checkpoint page renders it. The inputs differ, so each variant has its own cache entry; every
// caller of one shares that entry with the others.
/** The lean payload the PR overview card fans out across every snapshot in a PR. */
export function useSnapshotDetail(snapshotId: string) {
    return useSuspenseQuery(trpc.branches.snapshotDetail.queryOptions({ snapshotId }));
}

/** The lean payload plus the created-tests generation/run inspector. */
export function useFullSnapshotDetail(snapshotId: string) {
    return useSuspenseQuery(trpc.branches.snapshotDetail.queryOptions({ snapshotId, includeCreatedTests: true }));
}

export async function ensureFullSnapshotDetailData(queryClient: QueryClient, snapshotId: string) {
    await ensureAPIQueryData(
        queryClient,
        trpc.branches.snapshotDetail.queryOptions({ snapshotId, includeCreatedTests: true }),
    );
}

export function useSnapshotReport(snapshotId: string) {
    return useSuspenseQuery({
        ...trpc.branches.snapshotReport.queryOptions({ snapshotId }),
        refetchInterval: (query) => {
            const data = query.state.data;
            if (data == null) return false;
            return data.results.running > 0 || data.health === "running" ? 5000 : false;
        },
    });
}

export async function ensureSnapshotReportData(queryClient: QueryClient, snapshotId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.snapshotReport.queryOptions({ snapshotId }));
}

export function useActiveSnapshot(branchId: string) {
    return useSuspenseQuery(trpc.branches.activeSnapshot.queryOptions({ branchId }));
}

export async function ensureActiveSnapshotData(queryClient: QueryClient, branchId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.activeSnapshot.queryOptions({ branchId }));
}
