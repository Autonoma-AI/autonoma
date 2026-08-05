import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useAPIMutation } from "lib/query/api-queries";
import { toastManager } from "lib/toast-manager";
import { type RouterOutputs, trpc } from "lib/trpc";

const GITHUB_PR_STALE_TIME_MS = 5 * 60_000;
const GITHUB_REPOSITORY_STALE_TIME_MS = 5 * 60_000;
// Short so a focus refetch fires when the user returns from granting repo access.
const GITHUB_REPOSITORY_REFRESH_STALE_TIME_MS = 5_000;
const GITHUB_COMMIT_STALE_TIME_MS = 60 * 60_000;

/**
 * Return path for install flows opened in a NEW tab (add-another-repo): after
 * GitHub grants access it redirects the new tab to this terminal "you can close
 * this tab" page, instead of re-loading the origin page in a second tab. The
 * original tab refreshes its repo list on focus / when the tab closes.
 */
export const GITHUB_INSTALLED_RETURN_PATH = "/github-installed";

export function useGithubConfig(returnPath: string) {
    return useSuspenseQuery(trpc.github.getConfig.queryOptions({ returnPath }));
}

export function useGithubInstallation() {
    return useSuspenseQuery(trpc.github.getInstallation.queryOptions());
}

export function useGithubRepositories() {
    // Refetch when the tab regains focus: granting the GitHub App access to a new
    // repo happens in a separate tab, so returning to Autonoma should surface the
    // newly-connected repo without a manual reload. A short stale time makes the
    // focus refetch actually fire rather than serve a still-fresh cache.
    return useSuspenseQuery({
        ...trpc.github.listRepositories.queryOptions(),
        // The listing also reports when GitHub could not be read at all; the repo
        // pickers only render repositories, so they take the list.
        select: (listing) => listing.repos,
        staleTime: GITHUB_REPOSITORY_REFRESH_STALE_TIME_MS,
        refetchOnWindowFocus: true,
    });
}

export function useApplicationRepositoryFromGitHub(applicationId: string) {
    return useQuery({
        ...trpc.github.getApplicationRepository.queryOptions({ applicationId }),
        staleTime: GITHUB_REPOSITORY_STALE_TIME_MS,
        refetchOnWindowFocus: false,
        retry: false,
    });
}

export function useLinkRepository() {
    const queryClient = useQueryClient();
    const router = useRouter();
    return useAPIMutation({
        ...trpc.github.linkRepository.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.github.listRepositories.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.github.getInstallation.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
                // Re-run the app-shell loader so useCurrentApplication picks up the new link.
                void router.invalidate();
            },
        }),
        successToast: { title: "Repository linked" },
        errorToast: { title: "Failed to link repository" },
    });
}

export function useUnlinkRepository() {
    const queryClient = useQueryClient();
    const router = useRouter();
    return useAPIMutation({
        ...trpc.github.unlinkRepository.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.github.listRepositories.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.github.getInstallation.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
                // Re-run the app-shell loader so useCurrentApplication drops the link.
                void router.invalidate();
            },
        }),
        successToast: { title: "Repository unlinked" },
        errorToast: { title: "Failed to unlink repository" },
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

export function useTriggerConfig(applicationId: string) {
    return useSuspenseQuery(trpc.github.getTriggerConfig.queryOptions({ applicationId }));
}

export function useUpdateTriggerConfig(applicationId: string) {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.github.updateTriggerConfig.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.github.getTriggerConfig.queryKey({ applicationId }),
                });
            },
        }),
        successToast: { title: "Trigger settings saved" },
        errorToast: { title: "Failed to save trigger settings" },
    });
}

/** Why a requested run did not begin. */
type RunAnalysisNotStartedReason = Extract<RouterOutputs["github"]["runAnalysis"], { status: "not_started" }>["reason"];

/** What to tell the user for each no-op reason. */
const RUN_NOT_STARTED_MESSAGE: Record<RunAnalysisNotStartedReason, string> = {
    gate_disabled: "Autonoma is not enabled for this app yet.",
    activation_off: "On-request analysis is not enabled for this app yet.",
    already_analyzed: "This PR's latest commit was already analyzed - push a new commit to re-run.",
    failed: "Something went wrong starting the run. Please try again.",
};

export function useRunAnalysis() {
    return useAPIMutation({
        ...trpc.github.runAnalysis.mutationOptions({
            onSuccess: (result) => {
                if (result.status === "started") {
                    toastManager.add({
                        type: "success",
                        title: "Analysis started",
                        description: "Autonoma is analyzing this PR - the verdict will appear on the PR shortly.",
                    });
                    return;
                }
                toastManager.add({
                    type: "info",
                    title: "Nothing to analyze",
                    description: RUN_NOT_STARTED_MESSAGE[result.reason],
                });
            },
        }),
        errorToast: { title: "Failed to start analysis" },
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
