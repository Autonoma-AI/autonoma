import { type QueryClient, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ensureAPIQueryData, useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

export function useRuns() {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(trpc.runs.list.queryOptions({ applicationId: currentApp.id }));
}

export function useRunsPolling() {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(
        trpc.runs.list.queryOptions(
            { applicationId: currentApp.id },
            {
                refetchInterval: (query) => {
                    const data = query.state.data;
                    if (data == null) return false;
                    const hasActive = data.some((r) => r.status === "pending" || r.status === "running");
                    return hasActive ? 5000 : false;
                },
            },
        ),
    );
}

export function useRunDetail(
    runId: string,
    options?: {
        refetchInterval?: number | false | ((query: { state: { data: unknown } }) => number | false | undefined);
    },
) {
    return useSuspenseQuery(trpc.runs.detail.queryOptions({ runId }, options));
}

export async function ensureRunDetailData(queryClient: QueryClient, runId: string) {
    await ensureAPIQueryData(queryClient, trpc.runs.detail.queryOptions({ runId }));
}

export function useBranchRuns(applicationId: string, snapshotId?: string) {
    return useQuery({
        ...trpc.runs.list.queryOptions({ applicationId, snapshotId }),
        enabled: snapshotId != null,
        refetchInterval: (query) => {
            const data = query.state.data;
            if (data == null) return false;
            const hasActive = data.some((r) => r.status === "pending" || r.status === "running");
            return hasActive ? 5000 : false;
        },
    });
}

/**
 * The recent run history for a single test case (newest first), for the "Latest runs" panel on the test
 * detail page. Polls while a run is in flight so a just-triggered run resolves live. Not a suspense query -
 * the panel renders its own skeleton and empty state so it never blocks the plan from rendering.
 */
export function useTestCaseRuns(testCaseId: string) {
    return useQuery({
        ...trpc.runs.listForTestCase.queryOptions({ testCaseId }),
        refetchInterval: (query) => {
            const data = query.state.data;
            if (data == null) return false;
            const hasActive = data.some((r) => r.status === "pending" || r.status === "running");
            return hasActive ? 5000 : false;
        },
    });
}

export function useDeleteRun(runId: string) {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.runs.remove.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.runs.list.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.runs.detail.queryKey({ runId }) });
            },
        }),
        successToast: { title: "Run deleted" },
        errorToast: { title: "Failed to delete run" },
    });
}
