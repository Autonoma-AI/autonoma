import { type QueryClient, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ensureAPIQueryData, useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

export function useRuns() {
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

export function useRunTest() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.runs.trigger.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.runs.list.queryKey() });
            },
        }),
        successToast: { title: "Run started", description: "The test is now running." },
        errorToast: { title: "Failed to start run" },
    });
}

export function useRestartRun(runId: string) {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.runs.restart.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.runs.detail.queryKey({ runId }) });
                void queryClient.invalidateQueries({ queryKey: trpc.runs.list.queryKey() });
            },
        }),
        successToast: { title: "Run restarted" },
        errorToast: { title: "Failed to restart run" },
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
