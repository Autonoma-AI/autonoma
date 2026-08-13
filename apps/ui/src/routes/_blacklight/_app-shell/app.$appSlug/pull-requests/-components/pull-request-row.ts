import type { PrPipelineStatus } from "@autonoma/types";

/**
 * One pull request as the list renders it. Flattened from a `branches.list` item so the cells never reach back
 * into the branch shape, and so the two row layouts read the same fields.
 *
 * `createdAt` is here for the rows GitHub has not cached a `prUpdatedAt` for yet: the Updated cell falls back to
 * "opened X ago" rather than showing a dash, which is what the app's home surface showed before this list
 * absorbed it.
 */
export interface PullRequestRow {
    id: string;
    prNumber: number;
    branchName: string;
    baseBranchName: string;
    createdAt: Date;
    testCount: number;
    prStatus: PrPipelineStatus;
    prTitle?: string;
    prState?: "open" | "closed" | "merged";
    prAuthorLogin?: string;
    prUpdatedAt?: Date;
    snapshotId?: string;
    previewUrl?: string;
}
