import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc, trpcClient } from "lib/trpc";

/**
 * Reloads the page when a backend step-mismatch error is detected
 * ("Cannot X during Y step"). The route guard in the onboarding layout
 * then redirects the user to the correct step.
 */
function reloadOnStepMismatch(error: { message: string }) {
    if (error.message.startsWith("Cannot ") && error.message.includes(" during ")) {
        setTimeout(() => window.location.reload(), 2000);
    }
}

export function useOnboardingState(applicationId: string) {
    return useSuspenseQuery(trpc.onboarding.getState.queryOptions({ applicationId }));
}

export function useOnboardingStateOptional(applicationId: string) {
    return useQuery(trpc.onboarding.getState.queryOptions({ applicationId }, { enabled: applicationId.length > 0 }));
}

export function usePollAgentLogs(applicationId: string) {
    return useSuspenseQuery(trpc.onboarding.getLogs.queryOptions({ applicationId }, { refetchInterval: 2000 }));
}

export function useResetOnboarding(applicationId: string) {
    const queryClient = useQueryClient();
    return useAPIMutation({
        mutationFn: () => trpcClient.onboarding.reset.mutate({ applicationId }),
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
            void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getLogs.queryKey() });
        },
        errorToast: { title: "Failed to reset onboarding" },
    });
}

export function useStartConfigure(applicationId: string) {
    const queryClient = useQueryClient();
    return useAPIMutation({
        mutationFn: () => trpcClient.onboarding.startConfigure.mutate({ applicationId }),
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
        },
        onError: reloadOnStepMismatch,
        errorToast: { title: "Failed to start configuration" },
    });
}

export function useSetUrl(applicationId: string) {
    const queryClient = useQueryClient();
    return useAPIMutation({
        mutationFn: (input: { productionUrl: string }) =>
            trpcClient.onboarding.setUrl.mutate({ ...input, applicationId }),
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
        },
        onError: reloadOnStepMismatch,
        errorToast: { title: "Failed to set application URL" },
    });
}

export function useStartScenarioDryRun(applicationId: string) {
    const queryClient = useQueryClient();
    return useAPIMutation({
        mutationFn: () => trpcClient.onboarding.startScenarioDryRun.mutate({ applicationId }),
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
        },
        errorToast: { title: "Failed to start scenario dry run" },
    });
}

export function useConfigureAndDiscoverScenarios() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.configureAndDiscoverScenarios.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
            },
            onError: (error) => reloadOnStepMismatch(error),
        }),
        errorToast: { title: "Failed to save endpoint configuration" },
    });
}

export function useOnboardingScenarios(applicationId: string) {
    return useQuery(trpc.scenarios.list.queryOptions({ applicationId }));
}

export function useRunScenarioDryRun() {
    return useAPIMutation({
        ...trpc.onboarding.runScenarioDryRun.mutationOptions({
            onError: (error) => reloadOnStepMismatch(error),
        }),
        errorToast: { title: "Scenario dry run failed" },
    });
}

export function useCompleteOnboarding() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.complete.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
            },
            onError: (error) => reloadOnStepMismatch(error),
        }),
        errorToast: { title: "Failed to complete onboarding" },
    });
}

export function useCompleteGithub() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.completeGithub.mutationOptions({
            onSettled: () => void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() }),
        }),
        errorToast: { title: "Failed to complete Github onboarding" },
    });
}
