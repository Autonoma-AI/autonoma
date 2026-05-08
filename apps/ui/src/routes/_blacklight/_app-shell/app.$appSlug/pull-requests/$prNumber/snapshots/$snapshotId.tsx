import { Badge, Skeleton } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CameraIcon } from "@phosphor-icons/react/Camera";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { DiffsTimeline } from "components/snapshot/diffs-timeline";
import type { DiffsJobStatus } from "components/snapshot/diffs-timeline-types";
import { ShaRange } from "components/snapshot/sha-range";
import { formatDate } from "lib/format";
import { ensureSnapshotDetailData, useSnapshotDetail } from "lib/query/branches.queries";
import { Suspense } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId",
)({
  loader: async ({ context, params: { appSlug, snapshotId } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    await ensureSnapshotDetailData(context.queryClient, snapshotId);
  },
  component: SnapshotDetailPage,
});

function SnapshotDetailPage() {
  const { prNumber, snapshotId } = Route.useParams();

  return (
    <div className="flex flex-col gap-6">
      <Suspense fallback={<PageSkeleton prNumber={prNumber} />}>
        <SnapshotDetailContent prNumber={prNumber} snapshotId={snapshotId} />
      </Suspense>
    </div>
  );
}

function SnapshotDetailContent({ prNumber, snapshotId }: { prNumber: number; snapshotId: string }) {
  const { data } = useSnapshotDetail(snapshotId);
  const { snapshot, changes, diffsJob } = data;

  return (
    <>
      <PageHeader prNumber={prNumber}>
        <div className="flex flex-wrap items-center gap-3">
          <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
          <Badge variant={statusBadgeVariant(snapshot.status)}>{snapshot.status}</Badge>
          <Badge variant={diffsJobBadgeVariant(diffsJob.status)} className="font-mono uppercase">
            diffs: {diffsJob.status}
          </Badge>
          <span className="text-2xs text-text-tertiary">{formatDate(snapshot.createdAt)}</span>
        </div>
      </PageHeader>

      <DiffsTimeline diffsJob={diffsJob} changes={changes} />
    </>
  );
}

function PageHeader({ prNumber, children }: { prNumber: number; children: React.ReactNode }) {
  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-text-tertiary">
        <AppLink
          to="/app/$appSlug/pull-requests/$prNumber"
          params={{ prNumber }}
          aria-label="Back to pull request"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-primary"
        >
          <ArrowLeftIcon size={12} />
        </AppLink>
        <CameraIcon size={14} />
        <span className="font-mono text-2xs uppercase tracking-widest">Snapshot</span>
      </div>
      <h1 className="text-2xl font-medium tracking-tight text-text-primary">Snapshot detail</h1>
      {children}
    </header>
  );
}

function PageSkeleton({ prNumber }: { prNumber: number }) {
  return (
    <>
      <PageHeader prNumber={prNumber}>
        <Skeleton className="h-5 w-72" />
      </PageHeader>
      <div className="flex flex-col gap-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </>
  );
}

function statusBadgeVariant(status: string): "success" | "critical" | "outline" {
  switch (status) {
    case "active":
      return "success";
    case "failed":
      return "critical";
    default:
      return "outline";
  }
}

function diffsJobBadgeVariant(
  status: DiffsJobStatus,
): "status-passed" | "status-failed" | "status-running" | "status-pending" {
  switch (status) {
    case "completed":
      return "status-passed";
    case "failed":
      return "status-failed";
    case "pending":
      return "status-pending";
    default:
      return "status-running";
  }
}
