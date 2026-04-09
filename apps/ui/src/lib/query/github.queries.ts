import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

export function useGithubTestCases(applicationId: string) {
    return useSuspenseQuery(trpc.github.getTestCases.queryOptions({ applicationId }));
}

export function useGithubConfig(returnPath: string) {
    return useSuspenseQuery(trpc.github.getConfig.queryOptions({ returnPath }));
}

export function useGithubInstallation() {
    return useSuspenseQuery(trpc.github.getInstallation.queryOptions());
}

export function useGithubRepositories() {
    return useSuspenseQuery(trpc.github.listRepositories.queryOptions());
}

export function useUpdateRepoConfig() {
    return useAPIMutation({
        ...trpc.github.updateRepoConfig.mutationOptions(),
        errorToast: { title: "Failed to update repository config" },
    });
}

export function useDisconnectGithub() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.github.disconnect.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.github.getInstallation.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.github.listRepositories.queryKey() });
            },
        }),
        successToast: { title: "GitHub disconnected" },
        errorToast: { title: "Failed to disconnect GitHub" },
    });
}
