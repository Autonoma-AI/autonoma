import { type QueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

export function useDeploymentsByPr(applicationId: string, prNumber: number) {
    return useSuspenseQuery(trpc.deployments.listByPr.queryOptions({ applicationId, prNumber }));
}

const PREVIEW_POLL_MS = 5_000;
// Frontend preview statuses that are still in flight (a redeploy is building or pending). Terminal
// statuses (ready/degraded/failed/stopped/missing/unknown) stop the poll.
const ACTIVE_PREVIEW_STATUSES: ReadonlySet<string> = new Set(["building", "stale"]);

export function usePreviewEnvironmentSummary(
    applicationId: string,
    prNumber: number,
    options?: { refetchWhileActive?: boolean },
) {
    return useSuspenseQuery({
        ...trpc.deployments.previewSummaryByPr.queryOptions({ applicationId, prNumber }),
        refetchInterval: (query) =>
            options?.refetchWhileActive === true && ACTIVE_PREVIEW_STATUSES.has(query.state.data?.status ?? "")
                ? PREVIEW_POLL_MS
                : false,
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
