import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

const GITHUB_PR_STALE_TIME_MS = 5 * 60_000;
const GITHUB_COMMIT_STALE_TIME_MS = 60 * 60_000;

export function useGithubConfig(returnPath: string) {
    return useSuspenseQuery(trpc.github.getConfig.queryOptions({ returnPath }));
}

export function useGithubInstallation() {
    return useSuspenseQuery(trpc.github.getInstallation.queryOptions());
}

export function useGithubRepositories() {
    return useSuspenseQuery(trpc.github.listRepositories.queryOptions());
}

export function useLinkRepository() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.github.linkRepository.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.github.listRepositories.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.github.getInstallation.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
            },
        }),
        errorToast: { title: "Failed to link repository" },
    });
}

export function usePullRequestFromGitHub(applicationId: string, prNumber: number) {
    return useQuery({
        ...trpc.github.getPullRequest.queryOptions({ applicationId, prNumber }),
        staleTime: GITHUB_PR_STALE_TIME_MS,
        refetchOnWindowFocus: false,
        retry: false,
    });
}

export function usePullRequestCommits(applicationId: string, prNumber: number) {
    return useQuery({
        ...trpc.github.listPullRequestCommits.queryOptions({ applicationId, prNumber }),
        staleTime: GITHUB_PR_STALE_TIME_MS,
        refetchOnWindowFocus: false,
        retry: false,
    });
}

export function useCommitFromGitHub(applicationId: string, sha: string | undefined) {
    return useQuery({
        ...trpc.github.getCommit.queryOptions({ applicationId, sha: sha ?? "" }),
        enabled: sha != null && sha.length > 0,
        staleTime: GITHUB_COMMIT_STALE_TIME_MS,
        refetchOnWindowFocus: false,
        retry: false,
    });
}

export function useDisconnectGithub() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.github.disconnect.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.github.getInstallation.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.github.listRepositories.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
            },
        }),
        successToast: { title: "GitHub disconnected" },
        errorToast: { title: "Failed to disconnect GitHub" },
    });
}
