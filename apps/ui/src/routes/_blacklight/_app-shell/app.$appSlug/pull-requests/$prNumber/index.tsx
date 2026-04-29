import { Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ensureBranchByPrData, useBranchByPr, useSnapshotHistory } from "lib/query/branches.queries";
import { usePullRequestFromGitHub } from "lib/query/github.queries";
import { Suspense } from "react";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { PRDetailHeader } from "../-components/pr-detail-header";
import { PRHealthPanel } from "../-components/pr-health-panel";
import { PRMainContent } from "../-components/pr-main-content";
import { PRMetadataPanel } from "../-components/pr-metadata-panel";
import { SnapshotList } from "../-components/snapshot-list";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/")({
  loader: async ({ context, params: { appSlug, prNumber } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    await ensureBranchByPrData(context.queryClient, app.id, prNumber);
  },
  component: PullRequestDetailPage,
});

function PullRequestDetailPage() {
  const { prNumber } = Route.useParams();

  return (
    <div className="flex flex-col gap-6">
      <Suspense fallback={<PageSkeleton />}>
        <PullRequestDetailContent prNumber={prNumber} />
      </Suspense>
    </div>
  );
}

function PullRequestDetailContent({ prNumber }: { prNumber: number }) {
  const app = useCurrentApplication();
  const { data: branch } = useBranchByPr(app.id, prNumber);
  const { data: snapshots } = useSnapshotHistory(branch.id);
  const pr = usePullRequestFromGitHub(app.id, prNumber);
  const activeSnapshot = snapshots.find((s) => s.status === "active") ?? snapshots[0];

  return (
    <>
      <PRDetailHeader
        applicationId={app.id}
        prNumber={prNumber}
        branchName={branch.name}
        pr={pr.data ?? undefined}
        prPending={pr.isPending}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)_minmax(0,300px)]">
        <aside className="flex flex-col gap-6">
          <SnapshotList branchId={branch.id} applicationId={app.id} prNumber={prNumber} />
          <PRMetadataPanel pr={pr.data ?? undefined} prPending={pr.isPending} snapshotCount={snapshots.length} />
        </aside>

        <div className="min-w-0">
          <PRMainContent applicationId={app.id} prNumber={prNumber} pr={pr.data ?? undefined} />
        </div>

        <aside className="flex flex-col gap-6">
          {activeSnapshot != null ? (
            <PRHealthPanel applicationId={app.id} snapshot={activeSnapshot} />
          ) : (
            <EmptyHealthPanel />
          )}
        </aside>
      </div>
    </>
  );
}

function EmptyHealthPanel() {
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Health</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center text-text-tertiary">
          <GitPullRequestIcon size={28} />
          <p className="text-sm">No snapshots yet for this pull request.</p>
        </div>
      </PanelBody>
    </Panel>
  );
}

function PageSkeleton() {
  return (
    <>
      <Skeleton className="h-8 w-80" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)_minmax(0,300px)]">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </>
  );
}
