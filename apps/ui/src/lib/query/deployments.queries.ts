import { type QueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

export function useDeploymentsByPr(applicationId: string, prNumber: number) {
    return useSuspenseQuery(trpc.deployments.listByPr.queryOptions({ applicationId, prNumber }));
}

export function usePreviewEnvironmentSummary(applicationId: string, prNumber: number) {
    return useSuspenseQuery(trpc.deployments.previewSummaryByPr.queryOptions({ applicationId, prNumber }));
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
