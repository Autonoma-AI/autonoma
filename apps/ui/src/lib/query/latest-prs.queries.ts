import type { SnapshotHealth } from "@autonoma/blacklight";
import type { CheckpointPresentationSummary } from "@autonoma/types";
import { type QueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

// ─── Seam ─────────────────────────────────────────────────────────────────────
// Single source of truth for the Home "open pull requests" list. Today it reads
// the existing `branches.list` query and maps it to a row. A cached PR-overview
// procedure (with GitHub metadata: title, author, commits, bug counts, preview
// URL) is being built on a separate branch - when it lands, swap the query inside
// `useLatestPullRequests` / `ensureLatestPullRequestsData` and fill the optional
// fields below. The list/page rendering stays untouched.

export interface LatestPullRequest {
    id: string;
    prNumber: number;
    branchName: string;
    baseBranchName: string;
    health: SnapshotHealth;
    summary?: CheckpointPresentationSummary;
    testCount: number;
    createdAt: Date;
    // Enriched once the cached PR-overview procedure lands (undefined for now):
    title?: string;
    authorLogin?: string;
    commits?: number;
    bugCount?: number;
    previewUrl?: string;
}

export interface LatestPullRequestsPage {
    items: LatestPullRequest[];
    totalCount: number;
    pageCount: number;
    page: number;
}

export function useLatestPullRequests(page = 1): LatestPullRequestsPage {
    const currentApp = useCurrentApplication();
    const baseBranchName = currentApp.mainBranch.name;
    const { data } = useSuspenseQuery(
        trpc.branches.list.queryOptions({ applicationId: currentApp.id, state: "open", page }),
    );

    const items = data.items.flatMap((branch) =>
        branch.prNumber != null
            ? [
                  {
                      id: branch.id,
                      prNumber: branch.prNumber,
                      branchName: branch.name,
                      baseBranchName,
                      health: branch.activeSnapshot?.health ?? "unknown",
                      summary: branch.activeSnapshot?.summary ?? undefined,
                      testCount: branch.activeSnapshot?._count.testCaseAssignments ?? 0,
                      createdAt: branch.createdAt,
                      bugCount: branch.bugCount,
                      previewUrl: branch.previewUrl ?? undefined,
                  },
              ]
            : [],
    );

    // Already ordered by the server (most recently updated first) - re-sorting here would fight the paging and
    // shuffle rows within a page against the order the page boundary was cut on.
    return {
        items,
        totalCount: data.totalCount,
        pageCount: Math.max(1, Math.ceil(data.totalCount / data.pageSize)),
        page: data.page,
    };
}

export async function ensureLatestPullRequestsData(queryClient: QueryClient, applicationId: string, page = 1) {
    await ensureAPIQueryData(queryClient, trpc.branches.list.queryOptions({ applicationId, state: "open", page }));
}
