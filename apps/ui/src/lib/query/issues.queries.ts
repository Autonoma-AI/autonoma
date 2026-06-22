import type { QueryClient } from "@tanstack/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

export function useIssues() {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(trpc.issues.list.queryOptions({ applicationId: currentApp.id }));
}

export function useIssueDetail(issueId: string) {
    return useSuspenseQuery(trpc.issues.detail.queryOptions({ issueId }));
}

export async function ensureIssuesListData(queryClient: QueryClient, applicationId: string) {
    await ensureAPIQueryData(queryClient, trpc.issues.list.queryOptions({ applicationId }));
}

export async function ensureIssueDetailData(queryClient: QueryClient, issueId: string) {
    await ensureAPIQueryData(queryClient, trpc.issues.detail.queryOptions({ issueId }));
}
