import {
  Badge,
  Button,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CameraIcon } from "@phosphor-icons/react/Camera";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { Link, Outlet, createFileRoute, notFound, useLocation } from "@tanstack/react-router";
import { SentryLogsLink, TemporalLink } from "components/observability-links";
import type { DiffsJobStatus } from "components/snapshot/diffs-timeline-types";
import { PipelineStrip } from "components/snapshot/pipeline-strip";
import { ShaRange } from "components/snapshot/sha-range";
import { useAuth } from "lib/auth";
import { formatDate } from "lib/format";
import { ensureSnapshotDetailData, useSnapshotDetail } from "lib/query/branches.queries";
import { Suspense, useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId",
)({
  loader: async ({ context, params: { appSlug, snapshotId } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    await ensureSnapshotDetailData(context.queryClient, snapshotId);
  },
  component: SnapshotDetailLayout,
});

function SnapshotDetailLayout() {
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
  const { appSlug } = Route.useParams();
  const { data } = useSnapshotDetail(snapshotId);
  const { isAdmin } = useAuth();
  const { snapshot, changes, diffsJob, refinementLoop } = data;
  const [pipelineOpen, setPipelineOpen] = useState(false);

  const location = useLocation();
  const activeTab = location.pathname.includes("/changes") ? "changes" : "overview";

  return (
    <>
      <PageHeader prNumber={prNumber}>
        <div className="flex flex-wrap items-center gap-3">
          <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
          <StatusBadge status={snapshot.status} />
          <DiffsBadge status={diffsJob.status} />
          <span className="text-2xs text-text-tertiary">{formatDate(snapshot.createdAt)}</span>
          {isAdmin && (
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPipelineOpen((prev) => !prev)}
                aria-expanded={pipelineOpen}
              >
                <GearSixIcon size={14} />
                {pipelineOpen ? "Hide pipeline" : "Show pipeline"}
              </Button>
              {diffsJob.temporalWorkflow != null && (
                <TemporalLink
                  workflowId={diffsJob.temporalWorkflow.workflowId}
                  runId={diffsJob.temporalWorkflow.runId}
                />
              )}
              <SentryLogsLink filterField="snapshotId" filterValue={snapshot.id} />
            </div>
          )}
        </div>
      </PageHeader>

      <Tabs value={activeTab} className="gap-4">
        <TabsList variant="line">
          <TabsTrigger
            value="overview"
            render={
              <Link
                to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/overview"
                params={{ appSlug, prNumber, snapshotId }}
              />
            }
          >
            Overview
          </TabsTrigger>
          <TabsTrigger
            value="changes"
            render={
              <Link
                to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/changes"
                params={{ appSlug, prNumber, snapshotId }}
              />
            }
          >
            Test suite changes
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Outlet />

      {isAdmin && pipelineOpen && (
        <PipelineStrip diffsJob={diffsJob} changes={changes} refinementLoop={refinementLoop} snapshotId={snapshot.id} />
      )}
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant = statusBadgeVariant(status);
  if (status !== "active") {
    return <Badge variant={variant}>{status}</Badge>;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant={variant}>{status}</Badge>} />
      <TooltipContent>The snapshot currently used to evaluate this PR&apos;s test suite.</TooltipContent>
    </Tooltip>
  );
}

function DiffsBadge({ status }: { status: DiffsJobStatus }) {
  return (
    <Badge variant={diffsJobBadgeVariant(status)} className="font-mono uppercase">
      diffs: {status}
    </Badge>
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
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-48 w-full" />
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
