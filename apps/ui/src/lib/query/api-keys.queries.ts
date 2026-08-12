import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

export function useApiKeys() {
    return useSuspenseQuery(trpc.apiKeys.list.queryOptions());
}

/**
 * The keys one member holds, for the dialog that removes them. Suspends, so call it from a
 * component that only mounts once the dialog is open - a members list would otherwise fire one
 * request per row on first paint.
 */
export function useMemberApiKeys(userId: string) {
    return useSuspenseQuery(trpc.apiKeys.listForMember.queryOptions({ userId }));
}

export function useCreateApiKey() {
    const queryClient = useQueryClient();
    return useAPIMutation(
        trpc.apiKeys.create.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.apiKeys.list.queryKey() });
            },
        }),
    );
}

export function useDeleteApiKey() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.apiKeys.delete.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.apiKeys.list.queryKey() });
            },
        }),
        successToast: { title: "API key deleted" },
    });
}
