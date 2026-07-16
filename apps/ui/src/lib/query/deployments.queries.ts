import { type QueryClient, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ensureAPIQueryData, useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

export function useDeploymentsByPr(applicationId: string, prNumber: number) {
    return useSuspenseQuery(trpc.deployments.listByPr.queryOptions({ applicationId, prNumber }));
}

const PREVIEW_POLL_MS = 5_000;
// Previewkit environment health values that are still settling; while any listed env is in one of
// these, the list is polled so freshly-triggered deploys converge without a manual refresh.
const ACTIVE_ENV_HEALTH: ReadonlySet<string> = new Set(["building"]);

export function useActivePreviewEnvironments(applicationId: string) {
    return useSuspenseQuery({
        ...trpc.deployments.listActiveForApp.queryOptions({ applicationId }),
        refetchInterval: (query) => {
            const environments = query.state.data ?? [];
            const anyBuilding = environments.some((environment) => ACTIVE_ENV_HEALTH.has(environment.health));
            return anyBuilding ? PREVIEW_POLL_MS : false;
        },
    });
}

// Frontend preview statuses that are still in flight (a redeploy is building or pending). Terminal
// statuses (ready/degraded/failed/stopped/missing/unknown) stop the poll.
const ACTIVE_PREVIEW_STATUSES: ReadonlySet<string> = new Set(["building", "stale"]);
const ACTIVE_PREVIEW_PHASES: ReadonlySet<string> = new Set(["deploy_requested"]);

export function usePreviewEnvironmentSummary(
    applicationId: string,
    prNumber: number,
    options?: { refetchWhileActive?: boolean },
) {
    return useSuspenseQuery({
        ...trpc.deployments.previewSummaryByPr.queryOptions({ applicationId, prNumber }),
        refetchInterval: (query) => {
            const status = query.state.data?.status ?? "";
            const phase = query.state.data?.phase ?? "";
            const previewIsActive = ACTIVE_PREVIEW_STATUSES.has(status) || ACTIVE_PREVIEW_PHASES.has(phase);
            return options?.refetchWhileActive === true && previewIsActive ? PREVIEW_POLL_MS : false;
        },
    });
}

export function usePreviewSummaryById(
    applicationId: string,
    environmentId: string,
    options?: { refetchWhileActive?: boolean },
) {
    return useSuspenseQuery({
        ...trpc.deployments.previewSummaryById.queryOptions({ applicationId, environmentId }),
        refetchInterval: (query) => {
            const status = query.state.data?.status ?? "";
            const phase = query.state.data?.phase ?? "";
            const previewIsActive = ACTIVE_PREVIEW_STATUSES.has(status) || ACTIVE_PREVIEW_PHASES.has(phase);
            return options?.refetchWhileActive === true && previewIsActive ? PREVIEW_POLL_MS : false;
        },
    });
}

// Resolves a branch's preview environment summary without knowing its environment id (the main branch
// has no PR page, so its env - PR #0 - is reached via the branch). Used to decide whether the
// main-branch page shows a preview section; the explorer then polls by environment id.
export function usePreviewSummaryByBranchId(applicationId: string, branchId: string) {
    return useSuspenseQuery(trpc.deployments.previewSummaryByBranchId.queryOptions({ applicationId, branchId }));
}

export async function ensurePreviewSummaryByBranchIdData(
    queryClient: QueryClient,
    applicationId: string,
    branchId: string,
) {
    await ensureAPIQueryData(
        queryClient,
        trpc.deployments.previewSummaryByBranchId.queryOptions({ applicationId, branchId }),
    );
}

export async function ensureActivePreviewEnvironmentsData(queryClient: QueryClient, applicationId: string) {
    await ensureAPIQueryData(queryClient, trpc.deployments.listActiveForApp.queryOptions({ applicationId }));
}

export async function ensurePreviewSummaryByIdData(
    queryClient: QueryClient,
    applicationId: string,
    environmentId: string,
) {
    await ensureAPIQueryData(
        queryClient,
        trpc.deployments.previewSummaryById.queryOptions({ applicationId, environmentId }),
    );
}

export function useDeploymentHistory(
    applicationId: string,
    environmentId: string,
    options?: { pollWhileActive?: boolean },
) {
    return useSuspenseQuery({
        ...trpc.deployments.history.queryOptions({ applicationId, environmentId }),
        refetchInterval: (query) => {
            // Poll while a returned row is still building, and also while the environment itself is
            // in-flight (`pollWhileActive`): a freshly-triggered deploy's build row is written some
            // time after the deploy is requested, so without the latter the list would stop polling
            // in that gap and the new row would only appear on a manual refresh.
            const deployments = query.state.data ?? [];
            const anyBuilding = deployments.some((deployment) => deployment.status === "building");
            return anyBuilding || options?.pollWhileActive === true ? PREVIEW_POLL_MS : false;
        },
    });
}

export function useRedeployPreviewApp(applicationId: string, environmentId: string) {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.deployments.redeployApp.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.deployments.previewSummaryById.queryKey({ applicationId, environmentId }),
                });
                void queryClient.invalidateQueries({
                    queryKey: trpc.deployments.listActiveForApp.queryKey({ applicationId }),
                });
            },
        }),
        successToast: { title: "App redeploy triggered" },
        errorToast: { title: "Failed to trigger app redeploy" },
    });
}

// Resolves the scenarios a test user can be provisioned from, plus the preview's
// primary URL. Its own Suspense boundary (the Test user card is a secondary
// section) keeps it off the page's critical render path.
export function usePreviewTestUserOptions(applicationId: string, environmentId: string) {
    return useSuspenseQuery(trpc.deployments.testUserOptions.queryOptions({ applicationId, environmentId }));
}

export function usePreviewTestUserProvision() {
    return useAPIMutation({
        ...trpc.deployments.testUserProvision.mutationOptions(),
        errorToast: { title: "Failed to provision test user" },
    });
}

export function usePreviewTestUserTeardown() {
    return useAPIMutation({
        ...trpc.deployments.testUserTeardown.mutationOptions(),
        successToast: { title: "Test user torn down" },
        errorToast: { title: "Failed to tear down test user" },
    });
}

export async function ensureDeploymentsByPrData(queryClient: QueryClient, applicationId: string, prNumber: number) {
    await ensureAPIQueryData(queryClient, trpc.deployments.listByPr.queryOptions({ applicationId, prNumber }));
}

export async function ensurePreviewEnvironmentSummaryData(
    queryClient: QueryClient,
    applicationId: string,
    prNumber: number,
) {
    await ensureAPIQueryData(
        queryClient,
        trpc.deployments.previewSummaryByPr.queryOptions({ applicationId, prNumber }),
    );
}
