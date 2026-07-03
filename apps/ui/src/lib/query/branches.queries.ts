import { type QueryClient, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { env } from "env";
import { useAuth } from "lib/auth";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

export type PullRequestStateFilter = "open" | "closed" | "merged";

/**
 * A lightweight presence + counts check for the snapshot page's "Investigation" entry point (does a report
 * exist, and how many bugs). Internal-only: the query is enabled only for @autonoma.app users, and the API
 * procedure also enforces it. Returns undefined when no shadow report exists. Not a suspense query (optional).
 */
export function useInvestigationReport(snapshotId: string) {
    const { user } = useAuth();
    const isInternal = user?.email?.endsWith(`@${env.VITE_INTERNAL_DOMAIN}`) ?? false;
    return useQuery({
        ...trpc.branches.investigationReport.queryOptions({ snapshotId }),
        enabled: isInternal,
    });
}

/**
 * The structured investigation report (findings + signed media) for the in-app "View investigation" page.
 * Internal-only and enforced by the API procedure. A plain (non-suspense) query because the value is legitimately
 * undefined when no rich report exists for the snapshot (not yet backfilled / a parse failure) - the page renders
 * a graceful fallback for that, which useSuspenseQuery cannot express (it throws on undefined data).
 */
export function useInvestigationReportData(snapshotId: string) {
    return useQuery(trpc.branches.investigationReportData.queryOptions({ snapshotId }));
}

export async function ensureInvestigationReportData(queryClient: QueryClient, snapshotId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.investigationReportData.queryOptions({ snapshotId }));
}

export function useBranches(state: PullRequestStateFilter = "open") {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(trpc.branches.list.queryOptions({ applicationId: currentApp.id, state }));
}

export async function ensureBranchesData(
    queryClient: QueryClient,
    applicationId: string,
    state: PullRequestStateFilter = "open",
) {
    await ensureAPIQueryData(queryClient, trpc.branches.list.queryOptions({ applicationId, state }));
}

export function useBranchDetail(applicationId: string, branchName: string) {
    return useSuspenseQuery(trpc.branches.detailByName.queryOptions({ applicationId, branchName }));
}

export function useBranchByPr(applicationId: string, prNumber: number) {
    return useSuspenseQuery(trpc.branches.detailByPr.queryOptions({ applicationId, prNumber }));
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
    await ensureAPIQueryData(queryClient, trpc.branches.snapshotHistory.queryOptions({ branchId }));
}

const TERMINAL_DIFFS_JOB_STATUSES = new Set(["completed", "failed"]);
const INCOMPLETE_GENERATION_STATUSES = new Set(["pending", "queued", "running"]);

// The Temporal workflow link and refinement loop are only shown on the single-checkpoint page.
// Aggregate callers (the PR overview card) omit them so the server skips an external Temporal call
// and an extra query per snapshot. Lean callers keep the `{ snapshotId }` key so they share one
// cache entry; the full page uses a distinct key.
export type SnapshotDetailOptions = { includeWorkflow?: boolean; includeRefinementLoop?: boolean };

// The single-checkpoint page (and its nested changes routes) render the workflow link and refinement
// loop, so they request the full payload and share one cache entry under this key.
export const FULL_SNAPSHOT_DETAIL: SnapshotDetailOptions = { includeWorkflow: true, includeRefinementLoop: true };

function snapshotDetailQueryInput(snapshotId: string, options?: SnapshotDetailOptions) {
    const includeWorkflow = options?.includeWorkflow === true;
    const includeRefinementLoop = options?.includeRefinementLoop === true;
    if (!includeWorkflow && !includeRefinementLoop) return { snapshotId };
    return { snapshotId, includeWorkflow, includeRefinementLoop };
}

export function useSnapshotDetail(snapshotId: string, options?: SnapshotDetailOptions) {
    return useSuspenseQuery({
        ...trpc.branches.snapshotDetail.queryOptions(snapshotDetailQueryInput(snapshotId, options)),
        refetchInterval: (query) => {
            const data = query.state.data;
            if (data == null) return false;
            const affectedGens = data.diffsJob.affectedTests.map((t) => t.generation);
            const hasIncompleteGenerations = affectedGens.some(
                (g) => g != null && INCOMPLETE_GENERATION_STATUSES.has(g.status),
            );
            const hasInFlightDiffsJob = !TERMINAL_DIFFS_JOB_STATUSES.has(data.diffsJob.status);
            const hasInFlightLoop = data.refinementLoop?.status === "running";
            return hasIncompleteGenerations || hasInFlightDiffsJob || hasInFlightLoop ? 5000 : false;
        },
    });
}

export async function ensureSnapshotDetailData(
    queryClient: QueryClient,
    snapshotId: string,
    options?: SnapshotDetailOptions,
) {
    await ensureAPIQueryData(
        queryClient,
        trpc.branches.snapshotDetail.queryOptions(snapshotDetailQueryInput(snapshotId, options)),
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

export function useTestSuiteChangesByPr(branchId: string) {
    return useSuspenseQuery(trpc.branches.testSuiteChangesByPr.queryOptions({ branchId }));
}

export async function ensureTestSuiteChangesByPrData(queryClient: QueryClient, branchId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.testSuiteChangesByPr.queryOptions({ branchId }));
}
