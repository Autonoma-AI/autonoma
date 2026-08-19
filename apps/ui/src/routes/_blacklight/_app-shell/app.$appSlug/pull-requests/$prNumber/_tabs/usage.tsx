import { Panel, PanelBody, Skeleton } from "@autonoma/blacklight";
import { LockIcon } from "@phosphor-icons/react/Lock";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useAuth } from "lib/auth";
import { ensureBranchByPrData, useBranchByPr } from "lib/query/branches.queries";
import { ensurePreviewEnvironmentSummaryData, usePreviewEnvironmentSummary } from "lib/query/deployments.queries";
import { Suspense } from "react";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { AdminAiCostPanel } from "../../-components/admin-ai-cost-panel";
import { AdminComputeUsagePanel } from "../../-components/preview/admin-compute-usage-panel";

// Admin-only tab: AI cost + Previewkit compute usage for this PR, pulled out of the Analysis
// and Preview Environment tabs so they stay focused on PR content. `pr-tabs.tsx` only links here
// for admins, but this route also self-guards - a non-admin who navigates here directly (or has
// a stale bookmark from before losing admin) sees a restricted message, not a FORBIDDEN error
// bubbling out of the underlying admin-only queries.
export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/_tabs/usage")({
  loader: async ({ context, params: { appSlug, prNumber } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    // Both are keyed by (applicationId, prNumber) only, so neither waits on the other.
    await Promise.all([
      ensureBranchByPrData(context.queryClient, app.id, prNumber),
      ensurePreviewEnvironmentSummaryData(context.queryClient, app.id, prNumber),
    ]);
  },
  pendingComponent: UsageTabPending,
  component: UsageTab,
});

function UsageTabPending() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

function UsageTab() {
  const { prNumber } = Route.useParams();
  const { isAdmin } = useAuth();

  if (!isAdmin) return <NotAdminPanel />;

  return (
    <Suspense fallback={<UsageTabPending />}>
      <UsageTabBody prNumber={prNumber} />
    </Suspense>
  );
}

function UsageTabBody({ prNumber }: { prNumber: number }) {
  const app = useCurrentApplication();
  const { data: branch } = useBranchByPr(app.id, prNumber);
  const { data: envSummary } = usePreviewEnvironmentSummary(app.id, prNumber);

  return (
    <div className="flex flex-col gap-4 p-6">
      <AdminAiCostPanel branchId={branch.id} defaultOpen />
      {envSummary.source === "previewkit" && (
        <AdminComputeUsagePanel environmentId={envSummary.environmentId} defaultOpen />
      )}
    </div>
  );
}

function NotAdminPanel() {
  return (
    <div className="p-6">
      <Panel>
        <PanelBody>
          <div className="flex flex-col items-center justify-center gap-3 py-14 text-center text-text-secondary">
            <LockIcon size={28} />
            <p className="text-sm">This page is only available to admins.</p>
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}
