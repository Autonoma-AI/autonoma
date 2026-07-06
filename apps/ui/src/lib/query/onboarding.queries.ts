import type { SuggestionAppRef, SuggestionServiceRef } from "@autonoma/types";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

/**
 * Returns an onError handler that, on a backend step-mismatch error
 * ("Cannot X during Y step"), re-runs the route loaders so the refreshed
 * backend state is reflected. Uses `router.invalidate()` rather than a full
 * page reload so React state and the router are preserved. Note: this only
 * refetches - it does not change the URL `step`, since the flow intentionally
 * lets the URL run ahead of the backend in places (e.g. BYO "Continue to
 * verify" sits at `deploy-verify` while the backend is `existing_deploys_waiting`).
 */
function useStepMismatchHandler() {
    const router = useRouter();
    return (error: { message: string }) => {
        const isStepMismatch = error.message.startsWith("Cannot ") && error.message.includes(" during ");
        if (isStepMismatch) void router.invalidate();
    };
}

export function useOnboardingState(applicationId: string) {
    return useSuspenseQuery(trpc.onboarding.getState.queryOptions({ applicationId }));
}

export function useOnboardingStateOptional(applicationId: string) {
    return useQuery(trpc.onboarding.getState.queryOptions({ applicationId }, { enabled: applicationId.length > 0 }));
}

export function useConfigureAndDiscoverScenarios() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.configureAndDiscoverScenarios.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.listSdkDryRunTargets.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.scenarios.list.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to save endpoint configuration" },
    });
}

/**
 * Provision the managed target's secrets (auto-run when the SDK step loads). It
 * may kick off a one-time PreviewKit redeploy; the UI tracks readiness off the
 * polled target status, so on settle we refresh the targets + onboarding state.
 */
export function usePrepareSdkTarget() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.prepareSdkTarget.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.listSdkDryRunTargets.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
            },
        }),
        errorToast: { title: "Failed to prepare preview environment" },
    });
}

export function useConfigureAndDiscoverSdkTarget() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.configureAndDiscoverSdkTarget.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.listSdkDryRunTargets.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.scenarios.list.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to validate SDK target" },
    });
}

export function useOnboardingScenarios(applicationId: string) {
    return useQuery(trpc.scenarios.list.queryOptions({ applicationId }, { enabled: applicationId.length > 0 }));
}

export function useRunScenarioDryRun() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.runScenarioDryRun.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
            },
        }),
        errorToast: { title: "Scenario dry run failed" },
    });
}

/** Preview envs the SDK dry-run can target (open-PR previews + main, with auto-detect). */
export function useSdkDryRunTargets(applicationId: string) {
    return useSuspenseQuery(
        trpc.onboarding.listSdkDryRunTargets.queryOptions(
            { applicationId },
            {
                refetchInterval: (query) => {
                    const targets = query.state.data?.targets ?? [];
                    if (targets.length === 0) return 5_000;
                    const hasBuildingPreviewkitTarget = targets.some(
                        (target) =>
                            target.source === "previewkit" && target.status != null && target.status !== "ready",
                    );
                    return hasBuildingPreviewkitTarget ? 5_000 : false;
                },
            },
        ),
    );
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

export function useSelectPreviewEnvironmentMode() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.selectPreviewEnvironmentMode.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewReadiness.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to select preview environment" },
    });
}

export function useConfirmExistingDeploysSetup() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.confirmExistingDeploysSetup.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to confirm deploy setup" },
    });
}

export function useTriggerPreviewkitMainDeploy() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.triggerPreviewkitMainDeploy.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewReadiness.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to start PreviewKit deploy" },
    });
}

export function usePreviewkitConfig(applicationId: string) {
    return useSuspenseQuery(trpc.onboarding.getPreviewkitConfig.queryOptions({ applicationId }));
}

export function useSavePreviewkitConfig() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.savePreviewkitConfig.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewkitConfig.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewReadiness.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to save PreviewKit config" },
    });
}

export function useDeploymentSignalStatus(applicationId: string) {
    return useQuery(
        trpc.onboarding.getDeploymentSignalStatus.queryOptions(
            { applicationId },
            {
                enabled: applicationId.length > 0,
                // Stop polling once a signal has been accepted (previewUrl present).
                refetchInterval: (query) => {
                    const data = query.state.data;
                    const accepted = data != null && "previewUrl" in data && data.previewUrl != null;
                    return accepted ? false : 5_000;
                },
            },
        ),
    );
}

/**
 * Repo introspection suggestions for the topology builder. Deliberately not a
 * suspense query: it only runs on a fresh (never-saved) config, and any error
 * or empty result silently falls back to manual setup.
 */
export function useRepoSuggestions(applicationId: string, enabled: boolean, githubRepositoryId?: number) {
    return useQuery(
        trpc.onboarding.introspectRepository.queryOptions(
            { applicationId, githubRepositoryId },
            { enabled, staleTime: Number.POSITIVE_INFINITY, retry: false, refetchOnWindowFocus: false },
        ),
    );
}

/** AI-assisted service suggestions for the topology builder, inferred from the accepted apps. */
export function useSuggestServices(
    applicationId: string,
    enabled: boolean,
    apps: SuggestionAppRef[],
    githubRepositoryId?: number,
) {
    return useQuery(
        trpc.onboarding.suggestPreviewkitServices.queryOptions(
            { applicationId, apps, githubRepositoryId },
            { enabled, staleTime: Number.POSITIVE_INFINITY, retry: false, refetchOnWindowFocus: false },
        ),
    );
}

/** AI-assisted env-var suggestions for the topology builder, analyzed from each app's `.env.example`. */
export function useSuggestEnvVars(
    applicationId: string,
    enabled: boolean,
    apps: SuggestionAppRef[],
    services: SuggestionServiceRef[],
    githubRepositoryId?: number,
) {
    return useQuery(
        trpc.onboarding.suggestPreviewkitEnvVars.queryOptions(
            { applicationId, apps, services, githubRepositoryId },
            { enabled, staleTime: Number.POSITIVE_INFINITY, retry: false, refetchOnWindowFocus: false },
        ),
    );
}

/** Server-side config validation: schema + semantics + repo-aware preflight, returned as data. */
export function useValidatePreviewkitConfig() {
    return useAPIMutation({
        ...trpc.onboarding.validatePreviewkitConfig.mutationOptions({}),
        errorToast: { title: "Failed to validate PreviewKit config" },
    });
}

export function usePreviewkitSecrets(applicationId: string, appName: string) {
    return useSuspenseQuery(trpc.onboarding.listPreviewkitSecrets.queryOptions({ applicationId, appName }));
}

export function usePreviewkitSecretsOptional(applicationId: string, appName: string | undefined) {
    return useQuery(
        trpc.onboarding.listPreviewkitSecrets.queryOptions(
            { applicationId, appName: appName ?? "" },
            { enabled: appName != null && appName.length > 0 },
        ),
    );
}

export function useUpsertPreviewkitSecrets() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.upsertPreviewkitSecrets.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.listPreviewkitSecrets.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewReadiness.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to save PreviewKit secret" },
    });
}

export function useDeletePreviewkitSecret() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.deletePreviewkitSecret.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.listPreviewkitSecrets.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewReadiness.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to delete PreviewKit secret" },
    });
}

export function usePreviewReadiness(applicationId: string) {
    return useSuspenseQuery(
        trpc.onboarding.getPreviewReadiness.queryOptions(
            { applicationId },
            {
                // Stop polling on a terminal status. A redeploy/edit invalidates
                // this query, which refetches and resumes polling while building.
                refetchInterval: (query) => {
                    const status = query.state.data?.diagnostics.status;
                    return status === "ready" || status === "failed" ? false : 5_000;
                },
            },
        ),
    );
}

/** AI diagnosis of a failed deploy, keyed by `deployFingerprint` so it runs once per failure state. */
export function useDiagnosePreviewkitDeploy(applicationId: string, enabled: boolean, deployFingerprint: string) {
    return useQuery(
        trpc.onboarding.diagnosePreviewkitDeploy.queryOptions(
            { applicationId, deployFingerprint },
            { enabled, staleTime: Number.POSITIVE_INFINITY, retry: false, refetchOnWindowFocus: false },
        ),
    );
}

export function useCompletePreviewOnboarding() {
    const queryClient = useQueryClient();
    const router = useRouter();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.completePreviewOnboarding.mutationOptions({
            onSettled: async () => {
                await queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
                await queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewReadiness.queryKey() });
                await queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
                await router.invalidate();
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to complete preview onboarding" },
    });
}

export function useGoLive() {
    const queryClient = useQueryClient();
    const router = useRouter();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.goLive.mutationOptions({
            onSettled: async () => {
                await queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey() });
                await queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
                await router.invalidate();
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to go live" },
    });
}
