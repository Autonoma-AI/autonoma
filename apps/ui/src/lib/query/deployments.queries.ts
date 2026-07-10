import { type QueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ensureAPIQueryData } from "lib/query/api-queries";
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
