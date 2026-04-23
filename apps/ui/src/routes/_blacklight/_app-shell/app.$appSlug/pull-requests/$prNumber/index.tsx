import { Button, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ensureBranchByPrData, useBranchByPr } from "lib/query/branches.queries";
import { usePullRequestFromGitHub } from "lib/query/github.queries";
import { Suspense } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { PRStatusPanel } from "../-components/pr-status-panel";
import { SnapshotList, SnapshotListSkeleton } from "../-components/snapshot-list";

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
      <Suspense fallback={<PageSkeleton prNumber={prNumber} />}>
        <PullRequestDetailContent prNumber={prNumber} />
      </Suspense>
    </div>
  );
}

function PullRequestDetailContent({ prNumber }: { prNumber: number }) {
  const app = useCurrentApplication();
  const { data: branch } = useBranchByPr(app.id, prNumber);
  const pr = usePullRequestFromGitHub(app.id, prNumber);

  const title = pr.data?.title ?? branch.name;
  const authorLogin = pr.data?.authorLogin;
  const githubUrl = pr.data?.url;

  return (
    <>
      <PageHeader prNumber={prNumber}>
        <div className="flex items-start justify-between gap-4">
          {pr.isPending ? (
            <Skeleton className="h-7 w-96" />
          ) : (
            <h1 className="text-2xl font-medium tracking-tight text-text-primary">{title}</h1>
          )}
          <AppLink to="/app/$appSlug/pull-requests/$prNumber/suite" params={{ prNumber }}>
            <Button variant="outline" size="sm">
              <ListChecksIcon size={14} />
              View active suite
            </Button>
          </AppLink>
        </div>
      </PageHeader>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
        <PRStatusPanel
          branchName={branch.name}
          authorLogin={authorLogin}
          githubUrl={githubUrl}
          prPending={pr.isPending}
        />
        <SnapshotList branchId={branch.id} applicationId={app.id} prNumber={prNumber} />
      </div>
    </>
  );
}

function PageHeader({ prNumber, children }: { prNumber: number; children: React.ReactNode }) {
  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-text-tertiary">
        <AppLink
          to="/app/$appSlug/pull-requests"
          aria-label="Back to pull requests"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-primary"
        >
          <ArrowLeftIcon size={12} />
        </AppLink>
        <GitPullRequestIcon size={14} />
        <span className="font-mono text-2xs uppercase tracking-widest">Pull request</span>
        <span className="font-mono text-2xs">#{prNumber}</span>
      </div>
      {children}
    </header>
  );
}

function PageSkeleton({ prNumber }: { prNumber: number }) {
  return (
    <>
      <PageHeader prNumber={prNumber}>
        <Skeleton className="h-7 w-96" />
      </PageHeader>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
        <Panel>
          <PanelHeader>
            <PanelTitle>Status</PanelTitle>
          </PanelHeader>
          <PanelBody className="p-4">
            <Skeleton className="h-24 w-full" />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader className="flex items-center gap-2">
            <ClockCounterClockwiseIcon size={14} className="text-text-tertiary" />
            <PanelTitle>Snapshots</PanelTitle>
          </PanelHeader>
          <PanelBody className="p-4">
            <SnapshotListSkeleton />
          </PanelBody>
        </Panel>
      </div>
    </>
  );
}
