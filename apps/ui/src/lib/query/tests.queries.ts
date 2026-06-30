import { type QueryClient, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ensureAPIQueryData, useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { useCurrentSnapshot } from "routes/_blacklight/_app-shell/app.$appSlug/-use-main-branch";

export function useTests() {
    const { id: applicationId } = useCurrentApplication();
    return useSuspenseQuery(trpc.tests.list.queryOptions({ applicationId }));
}

// Decoupled version for use in blacklight routes (takes applicationId directly)
export function useTestsList(applicationId: string) {
    return useSuspenseQuery(trpc.tests.list.queryOptions({ applicationId }));
}

export function useTestDetail(slug: string) {
    const { id: applicationId } = useCurrentApplication();
    const { id: snapshotId } = useCurrentSnapshot();

    return useSuspenseQuery(trpc.tests.detail.queryOptions({ applicationId, slug, snapshotId }));
}

export async function ensureTestDetailData(
    queryClient: QueryClient,
    applicationId: string,
    slug: string,
    snapshotId: string,
) {
    return await ensureAPIQueryData(queryClient, trpc.tests.detail.queryOptions({ applicationId, slug, snapshotId }));
}

export function useRenameTest() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.tests.rename.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.tests.detail.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.tests.list.queryKey() });
            },
        }),
        errorToast: { title: "Failed to rename test" },
    });
}

export function useDeleteTest() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.tests.delete.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.tests.list.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.tests.detail.queryKey() });
            },
        }),
        successToast: { title: "Test deleted" },
        errorToast: { title: "Failed to delete test" },
    });
}
