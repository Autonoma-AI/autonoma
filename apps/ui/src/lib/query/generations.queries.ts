import { type QueryClient, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useAPIMutation } from "lib/query/api-queries";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

export function useGenerations() {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(trpc.generations.list.queryOptions({ applicationId: currentApp.id }));
}

export function useGenerationsPolling(options?: { refetchInterval?: number }) {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(trpc.generations.list.queryOptions({ applicationId: currentApp.id }, options));
}

export function useGenerationDetail(generationId: string) {
    return useSuspenseQuery({
        ...trpc.generations.detail.queryOptions({ generationId }),
        refetchInterval: (query) => {
            const data = query.state.data;
            if (data == null) return false;
            const isActive = data.status === "queued" || data.status === "pending" || data.status === "running";
            const isReviewPending = data.review?.status === "pending";
            return isActive || isReviewPending ? 5000 : false;
        },
    });
}

export async function ensureGenerationsListData(queryClient: QueryClient, applicationId: string) {
    await ensureAPIQueryData(queryClient, trpc.generations.list.queryOptions({ applicationId }));
}

export async function ensureGenerationDetailData(queryClient: QueryClient, generationId: string) {
    await ensureAPIQueryData(queryClient, trpc.generations.detail.queryOptions({ generationId }));
}

export function useRerunGeneration() {
    const queryClient = useQueryClient();
    const currentApp = useCurrentApplication();
    return useAPIMutation({
        ...trpc.generations.rerun.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.generations.list.queryKey({ applicationId: currentApp.id }),
                });
            },
        }),
        successToast: { title: "Generation restarted" },
        errorToast: { title: "Failed to restart generation" },
    });
}

export function useDeleteGeneration() {
    const queryClient = useQueryClient();
    const currentApp = useCurrentApplication();
    return useAPIMutation({
        ...trpc.generations.delete.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.generations.list.queryKey({ applicationId: currentApp.id }),
                });
            },
        }),
        successToast: { title: "Generation deleted" },
        errorToast: { title: "Failed to delete generation" },
    });
}
