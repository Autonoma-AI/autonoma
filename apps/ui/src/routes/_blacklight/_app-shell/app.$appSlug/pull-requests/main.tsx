import { Badge, Panel, PanelBody, Skeleton } from "@autonoma/blacklight";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { createFileRoute, notFound } from "@tanstack/react-router";
import type { PreviewLogSource } from "components/build-logs/preview-logs-tabs";
import { MainProblemsSection, MainProblemsSectionSkeleton } from "components/main-problems/main-problems-section";
import { ShaRange } from "components/snapshot/sha-range";
import { formatRelativeTime } from "lib/format";
import {
  ensureBranchData,
  ensureMainOpenProblemsData,
  ensurePrPipelineStatusData,
  ensureSnapshotHistoryData,
  useBranchDetail,
  usePrPipelineStatus,
  useSnapshotDetail,
  useSnapshotHistory,
} from "lib/query/branches.queries";
import {
  ensurePreviewSummaryByBranchIdData,
  usePreviewSummaryByBranchId,
  usePreviewSummaryById,
} from "lib/query/deployments.queries";
import type { RouterOutputs } from "lib/trpc";
import { Suspense } from "react";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { CheckpointSummaryBadge } from "./-components/checkpoint-summary-badge";
import { CheckpointTestsRun } from "./-components/checkpoint-tests-run";
import { checkpointTriggerLabel } from "./-components/checkpoint-trigger-label";
import { formatCheckpointMetrics } from "./-components/format-checkpoint-metrics";
import { PrStatusBadge } from "./-components/pr-status-badge";
import {
  EnvironmentSummaryStrip,
  EnvironmentSummaryStripSkeleton,
} from "./-components/preview/environment-summary-strip";
import {
  PreviewEnvironmentExplorer,
  PreviewEnvironmentExplorerSkeleton,
} from "./-components/preview/preview-environment-explorer";

type Snapshot = RouterOutputs["branches"]["snapshotHistory"][number];

// Persisted in the URL so a refresh keeps the selected preview service and log focus (build vs app).
type MainBranchSearch = { service?: string; logs?: PreviewLogSource };

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/main")({
  loader: async ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    const branch = await ensureBranchData(context.queryClient, app.id, app.mainBranch.name);
    await Promise.all([
      ensureSnapshotHistoryData(context.queryClient, branch.id),
      ensurePrPipelineStatusData(context.queryClient, app.id, branch.id),
      ensurePreviewSummaryByBranchIdData(context.queryClient, app.id, branch.id),
      ensureMainOpenProblemsData(context.queryClient, app.id),
    ]);
  },
  validateSearch: (search: Record<string, unknown>): MainBranchSearch => ({
    service: typeof search.service === "string" ? search.service : undefined,
    logs: search.logs === "build" || search.logs === "app" ? search.logs : undefined,
  }),
  pendingComponent: MainBranchPending,
  component: MainBranchPage,
});

/** The header is static, so the loader's wait shows it for real and skeletons only the body. */
function MainBranchPending() {
  return (
    <div className="flex flex-col gap-6">
      <MainBranchHeader />
      <MainBranchSkeleton />
    </div>
  );
}

function MainBranchHeader() {
  return (
    <header className="flex flex-wrap items-center gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-medium tracking-tight text-text-primary">
          <GitBranchIcon size={22} className="text-text-secondary" />
          Main branch
        </h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">
          Health, checkpoints and open problems on your default branch
        </p>
      </div>
    </header>
  );
}

function MainBranchPage() {
  return (
    <div className="flex flex-col gap-6">
      <MainBranchHeader />

      <Suspense fallback={<MainBranchSkeleton />}>
        <MainBranchContent />
      </Suspense>

      {/* `null` because this section legitimately renders nothing for an application without a previewkit
          environment; the skeleton lives inside, once we know there IS one. */}
      <Suspense fallback={null}>
        <MainBranchPreviewSection />
      </Suspense>
    </div>
  );
}

function MainBranchContent() {
  const app = useCurrentApplication();
  const { data: branch } = useBranchDetail(app.id, app.mainBranch.name);
  const { data: snapshots } = useSnapshotHistory(branch.id);
  const { data: prStatus } = usePrPipelineStatus(app.id, branch.id);

  const latest = snapshots[0];

  if (latest == null) {
    return (
      <Panel>
        <PanelBody>
          <div className="flex flex-col items-center justify-center gap-3 py-14 text-center text-text-secondary">
            <GitBranchIcon size={28} />
            <p className="text-sm">No checkpoints recorded on main yet</p>
          </div>
        </PanelBody>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3 border border-border-dim bg-surface-base px-5 py-3">
        <PrStatusBadge status={prStatus} />
        <ShaRange baseSha={latest.baseSha} headSha={latest.headSha} />
        <span className="ml-auto font-mono text-2xs text-text-secondary">
          {snapshots.length} {snapshots.length === 1 ? "checkpoint" : "checkpoints"} ·{" "}
          {formatRelativeTime(latest.createdAt)}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="flex flex-col gap-4">
          <Suspense fallback={<MainProblemsSectionSkeleton />}>
            <MainProblemsSection applicationId={app.id} />
          </Suspense>
          <LatestCheckpointTests snapshotId={latest.id} totalTests={latest.healthCounts.totalTests} />
        </div>
        <MainCheckpointRail snapshots={snapshots} />
      </div>
    </div>
  );
}

// The main branch's preview environment (the repository's PR #0), when one exists. Rendered as a
// sibling section - not gated on checkpoints - so it shows even before main has any checkpoint. The
// shared explorer is the same one the PR Preview tab uses.
function MainBranchPreviewSection() {
  const app = useCurrentApplication();
  const { data: branch } = useBranchDetail(app.id, app.mainBranch.name);
  const { data: summary } = usePreviewSummaryByBranchId(app.id, branch.id);

  if (summary.source !== "previewkit") return undefined;

  // The boundary sits here rather than around this component: most applications have no previewkit
  // environment and this returns nothing at all, so a skeleton one level up would promise a section that
  // never arrives.
  return (
    <Suspense fallback={<MainBranchPreviewSkeleton />}>
      <MainBranchPreviewExplorer applicationId={app.id} environmentId={summary.environmentId} />
    </Suspense>
  );
}

/** Mirrors `MainBranchPreviewExplorer`, reusing the same two skeletons the PR Preview tab does. */
function MainBranchPreviewSkeleton() {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-text-primary">Preview environment</h2>
      <EnvironmentSummaryStripSkeleton />
      <div className="flex h-[32rem] flex-col">
        <PreviewEnvironmentExplorerSkeleton />
      </div>
    </section>
  );
}

function MainBranchPreviewExplorer({ applicationId, environmentId }: { applicationId: string; environmentId: string }) {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: summary } = usePreviewSummaryById(applicationId, environmentId, { refetchWhileActive: true });

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-text-primary">Preview environment</h2>
      <EnvironmentSummaryStrip applicationId={applicationId} environmentId={environmentId} summary={summary} />
      <div className="flex h-[32rem] flex-col">
        <PreviewEnvironmentExplorer
          applicationId={applicationId}
          environmentId={environmentId}
          summary={summary}
          search={search}
          onSearchChange={(partial) => void navigate({ search: (prev) => ({ ...prev, ...partial }), replace: true })}
        />
      </div>
    </section>
  );
}

function LatestCheckpointTests({ snapshotId, totalTests }: { snapshotId: string; totalTests: number }) {
  const { data: detail } = useSnapshotDetail(snapshotId);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-text-primary">Latest checkpoint</h2>
      <CheckpointTestsRun
        executedTests={detail.executedTests}
        totalTests={totalTests}
        executionState={detail.summary?.executionState}
      />
    </section>
  );
}

function MainCheckpointRail({ snapshots }: { snapshots: Snapshot[] }) {
  return (
    <aside className="flex min-h-0 flex-col border border-border-dim bg-surface-base">
      <div className="border-b border-border-dim px-4 py-3">
        <h3 className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
          Checkpoint history
        </h3>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {snapshots.map((snapshot, index) => (
          <MainCheckpointRow key={snapshot.id} snapshot={snapshot} isLatest={index === 0} />
        ))}
      </div>
    </aside>
  );
}

/**
 * One checkpoint on main. The verdict is the derived `CheckpointSummaryBadge` the PR surfaces render, never the raw
 * `health` signal beside it: an amber "Not confirmed" run (raw `health` `unknown`) would lose its badge entirely.
 * "Latest" marks the newest row without standing in for its verdict, so every row says how its run went.
 */
function MainCheckpointRow({ snapshot, isLatest }: { snapshot: Snapshot; isLatest: boolean }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border-dim px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {snapshot.summary != null && (
          <CheckpointSummaryBadge summary={snapshot.summary} className="font-mono uppercase tracking-wider" />
        )}
        {isLatest && (
          <Badge variant="outline" className="font-mono uppercase tracking-wider text-text-secondary">
            Latest
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
        <span className="font-mono text-2xs text-text-secondary">{formatRelativeTime(snapshot.createdAt)}</span>
      </div>
      <span className="font-mono text-2xs text-text-secondary">
        {formatCheckpointMetrics(snapshot.summary, snapshot.healthCounts.totalTests)}
        {" · "}
        {checkpointTriggerLabel(snapshot.source)}
      </span>
    </div>
  );
}

function MainBranchSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <Skeleton className="h-12 w-full" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}
