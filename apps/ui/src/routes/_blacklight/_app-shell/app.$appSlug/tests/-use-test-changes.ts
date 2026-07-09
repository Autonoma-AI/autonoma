import { useQuery } from "@tanstack/react-query";
import { trpc } from "lib/trpc";
import { createContext, useContext } from "react";

export type TestChangeStatus = "added" | "modified";

export interface RemovedTest {
    id: string;
    name: string;
    slug: string;
}

export interface BranchTestChanges {
    /** Per-test-case change status vs the branch's divergence point on main. Absent id → unchanged. */
    byTestId: Map<string, TestChangeStatus>;
    /** Tests that are new on this branch (rendered green in the tree). */
    addedCount: number;
    /** Tests whose plan changed on this branch (rendered with a lime dot). */
    modifiedCount: number;
    /** Tests deleted on this branch vs main. They no longer exist in the tree, so we surface them separately. */
    removed: RemovedTest[];
}

const EMPTY_CHANGES: BranchTestChanges = { byTestId: new Map(), addedCount: 0, modifiedCount: 0, removed: [] };

/**
 * The added/modified test set for the selected branch, from `testSuiteChangesByPr`. Only meaningful for an
 * open PR branch - `main` is the baseline, so `enabled` is false there and everything reads as unchanged.
 * A plain (non-suspense) query: the markers are decorative and must never block the tree from rendering.
 */
export function useBranchTestChanges(branchId: string, enabled: boolean): BranchTestChanges {
    const { data } = useQuery({
        ...trpc.branches.testSuiteChangesByPr.queryOptions({ branchId }),
        enabled,
    });

    if (data == null) return EMPTY_CHANGES;

    const byTestId = new Map<string, TestChangeStatus>();
    for (const row of data.added) byTestId.set(row.testCase.id, "added");
    for (const row of data.modified) byTestId.set(row.testCase.id, "modified");
    const removed = data.removed.map((row) => ({
        id: row.testCase.id,
        name: row.testCase.name,
        slug: row.testCase.slug,
    }));

    return { byTestId, addedCount: data.added.length, modifiedCount: data.modified.length, removed };
}

export const TestChangesContext = createContext<BranchTestChanges>(EMPTY_CHANGES);

export function useTestChanges(): BranchTestChanges {
    return useContext(TestChangesContext);
}
