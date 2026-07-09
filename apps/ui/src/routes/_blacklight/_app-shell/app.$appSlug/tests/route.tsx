import { Button, Skeleton } from "@autonoma/blacklight";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { createFileRoute, notFound, Outlet, redirect } from "@tanstack/react-router";
import { useAuth } from "lib/auth";
import { ensureBranchData } from "lib/query/branches.queries";
import { Suspense } from "react";
import { useIsMainBranchSelected, useSelectedBranch } from "../-use-selected-branch";
import { AppLink } from "../../-app-link";
import { useBranchActivity } from "../../-layout/use-branch-activity";
import { AgentGeneratingView } from "./-agent-generating-view";
import { BranchPicker } from "./-branch-picker";
import { TestsTreeProvider } from "./-tests-tree/tests-tree-context";
import { TestsTreePanel } from "./-tests-tree/tests-tree-panel";
import { TestChangesContext, useBranchTestChanges } from "./-use-test-changes";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/tests")({
  validateSearch: (search: Record<string, unknown>): { branch?: string } => ({
    branch: typeof search.branch === "string" ? search.branch : undefined,
  }),
  loaderDeps: ({ search }) => ({ branch: search.branch }),
  // Prefetch the selected branch so switching branches (even with no test open) doesn't blank the page while
  // useSelectedBranch resolves - TanStack keeps the previous content until the branch data is cached.
  loader: async ({ context, params: { appSlug }, deps: { branch } }) => {
    const app = context.applications.find((a: { slug: string }) => a.slug === appSlug);
    if (app == null) throw notFound();
    try {
      await ensureBranchData(context.queryClient, app.id, branch ?? app.mainBranch.name);
    } catch (error) {
      // A stale or invalid `?branch=` (deleted/renamed branch) should degrade to main, not the route error
      // boundary. Only the explicit param can be bad here - a failing main branch is a genuine error, so rethrow.
      if (branch == null) throw error;
      console.warn("Unknown branch in ?branch=, falling back to main", { branch, error });
      throw redirect({ to: "/app/$appSlug/tests", params: { appSlug }, search: { branch: undefined } });
    }
  },
  component: TestsPage,
});

function TreePanelSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="ml-4 h-4 w-24" />
      <Skeleton className="ml-4 h-4 w-28" />
      <Skeleton className="ml-4 h-4 w-20" />
    </div>
  );
}

function BranchMeta({
  testCount,
  addedCount,
  modifiedCount,
}: {
  testCount: number;
  addedCount: number;
  modifiedCount: number;
}) {
  const changeParts: string[] = [];
  if (addedCount > 0) changeParts.push(`${addedCount} new`);
  if (modifiedCount > 0) changeParts.push(`${modifiedCount} modified`);

  return (
    <p className="mt-2 flex items-center gap-2 font-mono text-xs text-text-secondary">
      <span>
        {testCount} {testCount === 1 ? "test" : "tests"}
      </span>
      {changeParts.length > 0 && (
        <>
          <span>·</span>
          <span className="flex items-center gap-1.5 text-text-primary">
            <span className="size-1.5 shrink-0 bg-primary" />
            {changeParts.join(" · ")} on this branch
          </span>
        </>
      )}
    </p>
  );
}

function TestsPage() {
  const branch = useSelectedBranch();
  const isMain = useIsMainBranchSelected();
  const testCount = branch.activeSnapshot.testCaseAssignments.length;
  const hasPending = branch.pendingSnapshotId != null;
  const { isAdmin } = useAuth();
  const { state, activities } = useBranchActivity();

  const changes = useBranchTestChanges(branch.id, !isMain);

  const isGenerating = testCount === 0 && (state === "working" || activities.some((a) => a.type === "generation"));

  const header = (
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-medium tracking-tight text-text-primary">Tests</h1>
          <BranchPicker />
        </div>
        <BranchMeta testCount={testCount} addedCount={changes.addedCount} modifiedCount={changes.modifiedCount} />
      </div>

      {isAdmin && (
        <Button size="sm" className="shrink-0 gap-1.5 font-mono text-2xs" render={<AppLink to="/app/$appSlug/edit" />}>
          <PencilSimpleIcon size={12} />
          {hasPending ? "Continue editing" : "Edit test suite"}
        </Button>
      )}
    </header>
  );

  if (isGenerating) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div className="flex min-h-[400px] border border-border-mid bg-surface-raised">
          <AgentGeneratingView activities={activities} />
        </div>
      </div>
    );
  }

  return (
    <TestChangesContext.Provider value={changes}>
      <TestsTreeProvider>
        <div className="flex flex-col gap-6">
          {header}

          <div className="flex min-h-0 flex-1 gap-4">
            <div className="w-72 shrink-0 overflow-hidden">
              <div className="h-full border border-border-mid bg-surface-raised">
                <Suspense fallback={<TreePanelSkeleton />}>
                  <TestsTreePanel />
                </Suspense>
              </div>
            </div>

            <div className="min-w-0 flex-1 overflow-hidden border border-border-mid bg-surface-raised">
              <Outlet />
            </div>
          </div>
        </div>
      </TestsTreeProvider>
    </TestChangesContext.Provider>
  );
}
