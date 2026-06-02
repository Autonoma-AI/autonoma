import type { QueryClient } from "@tanstack/react-query";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ensureAPIQueryData, useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

export function useBugs(status?: "open" | "resolved" | "regressed") {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(trpc.bugs.list.queryOptions({ applicationId: currentApp.id, status }));
}

export function useBugsListByPr(
    applicationId: string,
    branchId: string,
    status: "open" | "resolved" | "regressed" = "open",
    snapshotId?: string,
) {
    const input =
        snapshotId != null ? { applicationId, branchId, status, snapshotId } : { applicationId, branchId, status };
    return useSuspenseQuery(trpc.bugs.listByPr.queryOptions(input));
}

export function useBugDetail(bugId: string) {
    return useSuspenseQuery(trpc.bugs.detail.queryOptions({ bugId }));
}

export async function ensureBugsListData(queryClient: QueryClient, applicationId: string) {
    await ensureAPIQueryData(queryClient, trpc.bugs.list.queryOptions({ applicationId }));
}

export async function ensureBugDetailData(queryClient: QueryClient, bugId: string) {
    await ensureAPIQueryData(queryClient, trpc.bugs.detail.queryOptions({ bugId }));
}

export function useDismissIssue() {
    const queryClient = useQueryClient();
    const currentApp = useCurrentApplication();
    return useAPIMutation(
        trpc.bugs.dismissIssue.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.bugs.list.queryKey({ applicationId: currentApp.id }),
                });
            },
        }),
    );
}

export function useResolveBug(bugId: string) {
    const queryClient = useQueryClient();
    const currentApp = useCurrentApplication();
    return useAPIMutation(
        trpc.bugs.resolve.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.bugs.detail.queryKey({ bugId }),
                });
                void queryClient.invalidateQueries({
                    queryKey: trpc.bugs.list.queryKey({ applicationId: currentApp.id }),
                });
            },
        }),
    );
}

export function useClassificationEnabled(enabled: boolean) {
    return useQuery({
        ...trpc.bugs.classificationEnabled.queryOptions(),
        enabled,
    });
}

export function useClassifyBug() {
    return useAPIMutation({
        ...trpc.bugs.classify.mutationOptions(),
        successToast: { title: "Classification recorded" },
    });
}

export function useReopenBug(bugId: string) {
    const queryClient = useQueryClient();
    const currentApp = useCurrentApplication();
    return useAPIMutation(
        trpc.bugs.reopen.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.bugs.detail.queryKey({ bugId }),
                });
                void queryClient.invalidateQueries({
                    queryKey: trpc.bugs.list.queryKey({ applicationId: currentApp.id }),
                });
            },
        }),
    );
}
