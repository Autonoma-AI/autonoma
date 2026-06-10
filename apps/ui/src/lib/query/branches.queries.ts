import { type QueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

export type PullRequestStateFilter = "open" | "closed" | "merged";

export function useBranches(state: PullRequestStateFilter = "open") {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(trpc.branches.list.queryOptions({ applicationId: currentApp.id, state }));
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

export function useSnapshotDetail(snapshotId: string) {
    return useSuspenseQuery({
        ...trpc.branches.snapshotDetail.queryOptions({ snapshotId }),
        refetchInterval: (query) => {
            const data = query.state.data;
            if (data == null) return false;
            const allGens = [
                ...data.diffsJob.affectedTests.map((t) => t.generation),
                ...data.diffsJob.testCandidates.map((c) => c.generation),
            ];
            const hasIncompleteGenerations = allGens.some(
                (g) => g != null && INCOMPLETE_GENERATION_STATUSES.has(g.status),
            );
            const hasInFlightDiffsJob = !TERMINAL_DIFFS_JOB_STATUSES.has(data.diffsJob.status);
            const hasInFlightLoop = data.refinementLoop?.status === "running";
            return hasIncompleteGenerations || hasInFlightDiffsJob || hasInFlightLoop ? 5000 : false;
        },
    });
}

export async function ensureSnapshotDetailData(queryClient: QueryClient, snapshotId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.snapshotDetail.queryOptions({ snapshotId }));
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
