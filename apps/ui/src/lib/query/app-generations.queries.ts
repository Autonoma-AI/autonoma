import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useAPIMutation } from "lib/query/api-queries";
import { invalidateOnboardingState } from "lib/query/onboarding.queries";
import { trpc } from "lib/trpc";

export function usePollApplicationSetup(applicationId: string) {
    return useSuspenseQuery(
        trpc.applicationSetups.getLatest.queryOptions({ applicationId }, { refetchInterval: 2000 }),
    );
}

/**
 * Polls the per-artifact upload status while the planner CLI runs. Keeps polling
 * until the step is genuinely done (`stepComplete` - run completed AND every
 * artifact received) rather than just `complete`, so a later re-upload is picked
 * up without a manual refresh. `stepComplete` is computed server-side so the gate
 * is never re-derived here.
 */
export function useArtifactStatus(applicationId: string) {
    return useSuspenseQuery(
        trpc.applicationSetups.artifactStatus.queryOptions(
            { applicationId },
            { refetchInterval: (query) => (query.state.data?.stepComplete === true ? false : 5000) },
        ),
    );
}

/**
 * The setup id a planner command should carry. Mints nothing, so it is safe to run
 * on render - which is the whole reason it is separate from {@link useMintCliToken}.
 */
export function useCliSetupId(applicationId: string) {
    return useSuspenseQuery(trpc.applicationSetups.resolveCliSetup.queryOptions({ applicationId }));
}

/**
 * Mints the token the CLI authenticates with. Call this when the command is COPIED,
 * never when it is rendered: looking at a screen must not leave a live credential
 * behind in the organization.
 */
export function useMintCliToken() {
    return useAPIMutation(trpc.applicationSetups.mintCliToken.mutationOptions());
}

/**
 * Mints an upload token + setup in one call. Finish setup renders the token in full
 * rather than masked, so it genuinely needs both at once. New screens should use
 * {@link useCliSetupId} + {@link useMintCliToken}.
 */
export function usePrepareCliSetup() {
    return useAPIMutation(trpc.applicationSetups.prepareCliSetup.mutationOptions());
}

export function useUploadScenarioRecipeVersions() {
    return useAPIMutation(trpc.applicationSetups.uploadScenarioRecipeVersions.mutationOptions());
}

export function useUploadSetupArtifacts() {
    return useAPIMutation(trpc.applicationSetups.uploadArtifacts.mutationOptions());
}

export function useUpdateSetup(applicationId: string) {
    const queryClient = useQueryClient();
    return useAPIMutation(
        trpc.applicationSetups.updateSetup.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.applicationSetups.artifactStatus.queryKey({ applicationId }),
                });
                void invalidateOnboardingState(queryClient, applicationId);
            },
        }),
    );
}
