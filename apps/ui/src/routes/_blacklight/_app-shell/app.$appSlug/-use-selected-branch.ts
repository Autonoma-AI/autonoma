import { useSearch } from "@tanstack/react-router";
import { useBranchDetail } from "lib/query/branches.queries";
import { useCurrentApplication } from "../-use-current-application";

/**
 * The git branch the Tests page is scoped to. Persisted in the `?branch=` search param (never localStorage)
 * so a refresh or shared link keeps the same branch. Falls back to the app's main branch when absent, so the
 * page always has a valid branch to render.
 */
export function useSelectedBranchName(): string {
    const app = useCurrentApplication();
    // Route-typed search (avoids an `as` cast); every caller lives under the tests route where `branch` is validated.
    const { branch } = useSearch({ from: "/_blacklight/_app-shell/app/$appSlug/tests" });
    return branch ?? app.mainBranch.name;
}

export function useIsMainBranchSelected(): boolean {
    const app = useCurrentApplication();
    return useSelectedBranchName() === app.mainBranch.name;
}

/**
 * The full branch detail (active snapshot + test assignments) for the currently selected branch. Drives the
 * tree, the meta counts, and the test detail's snapshot scope. Suspense-backed; the selected branch always
 * resolves to a real branch (main by default, or an open PR branch chosen in the picker).
 */
export function useSelectedBranch() {
    const app = useCurrentApplication();
    const branchName = useSelectedBranchName();
    return useBranchDetail(app.id, branchName).data;
}
