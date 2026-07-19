import { Badge, Panel, PanelBody, Skeleton } from "@autonoma/blacklight";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { createFileRoute, notFound } from "@tanstack/react-router";
import type { PreviewLogSource } from "components/build-logs/preview-logs-tabs";
import { ShaRange } from "components/snapshot/sha-range";
import { formatRelativeTime } from "lib/format";
import {
  ensureBranchData,
  ensurePrPipelineStatusData,
  ensureSnapshotHistoryData,
  useBranchDetail,
  usePrPipelineStatus,
  useSnapshotDetail,
  useSnapshotHistory,
} from "lib/query/branches.queries";
import { useBugsListByBranch } from "lib/query/bugs.queries";
import {
  ensurePreviewSummaryByBranchIdData,
  usePreviewSummaryByBranchId,
  usePreviewSummaryById,
} from "lib/query/deployments.queries";
import type { RouterOutputs } from "lib/trpc";
import { Suspense } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { CheckpointTestsRun } from "./-components/checkpoint-tests-run";
import { formatCheckpointMetrics } from "./-components/format-checkpoint-metrics";
import { PrStatusBadge } from "./-components/pr-status-badge";
import { EnvironmentSummaryStrip } from "./-components/preview/environment-summary-strip";
import { PreviewEnvironmentExplorer } from "./-components/preview/preview-environment-explorer";

type Snapshot = RouterOutputs["branches"]["snapshotHistory"][number];
type Bug = RouterOutputs["bugs"]["listByBranch"][number];

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
    ]);
  },
  validateSearch: (search: Record<string, unknown>): MainBranchSearch => ({
    service: typeof search.service === "string" ? search.service : undefined,
    logs: search.logs === "build" || search.logs === "app" ? search.logs : undefined,
  }),
  component: MainBranchPage,
});

function MainBranchPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-medium tracking-tight text-text-primary">
            <GitBranchIcon size={22} className="text-text-tertiary" />
            Main branch
          </h1>
          <p className="mt-1 font-mono text-xs text-text-secondary">
            Health, checkpoints and bugs on your default branch
          </p>
        </div>
      </header>

      <Suspense fallback={<MainBranchSkeleton />}>
        <MainBranchContent />
      </Suspense>

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
  const { data: bugs } = useBugsListByBranch(branch.id, "open");
  const { data: prStatus } = usePrPipelineStatus(app.id, branch.id);

  const ordered = [...snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const latest = ordered[0];

  if (latest == null) {
    return (
      <Panel>
        <PanelBody>
          <div className="flex flex-col items-center justify-center gap-3 py-14 text-center text-text-tertiary">
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
        <span className="ml-auto font-mono text-2xs text-text-tertiary">
          {ordered.length} {ordered.length === 1 ? "checkpoint" : "checkpoints"} ·{" "}
          {formatRelativeTime(latest.createdAt)}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="flex flex-col gap-4">
          {bugs.length > 0 && <MainBugsSection bugs={bugs} />}
          <LatestCheckpointTests snapshotId={latest.id} totalTests={latest.healthCounts.totalTests} />
        </div>
        <MainCheckpointRail snapshots={ordered} />
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

  return <MainBranchPreviewExplorer applicationId={app.id} environmentId={summary.environmentId} />;
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

function MainBugsSection({ bugs }: { bugs: Bug[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-text-primary">
        Open bugs on main · <span className="font-mono text-text-tertiary">{bugs.length}</span>
      </h2>
      <div className="flex flex-col gap-2">
        {bugs.map((bug) => (
          <MainBugRow key={bug.id} bug={bug} />
        ))}
      </div>
    </section>
  );
}

function MainBugRow({ bug }: { bug: Bug }) {
  return (
    <AppLink
      to="/app/$appSlug/bugs/$bugId"
      params={{ bugId: bug.id }}
      className="flex flex-col gap-1 border border-border-dim bg-surface-void px-4 py-3 transition-colors hover:border-border-mid hover:bg-surface-raised"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Badge variant={SEVERITY_BADGE[bug.severity] ?? "secondary"}>{bug.severity}</Badge>
        <span className="truncate text-sm font-medium text-text-primary">{bug.title}</span>
      </div>
      {bug.description.trim() !== "" && (
        <p className="line-clamp-2 text-sm leading-relaxed text-text-secondary">{bug.description}</p>
      )}
    </AppLink>
  );
}

function MainCheckpointRail({ snapshots }: { snapshots: Snapshot[] }) {
  return (
    <aside className="flex min-h-0 flex-col border border-border-dim bg-surface-base">
      <div className="border-b border-border-dim px-4 py-3">
        <h3 className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">
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

function MainCheckpointRow({ snapshot, isLatest }: { snapshot: Snapshot; isLatest: boolean }) {
  const isHealthy = snapshot.health === "healthy" && snapshot.bugCount === 0;

  return (
    <div className="flex flex-col gap-2 border-b border-border-dim px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        {isLatest ? (
          <Badge variant="outline" className="font-mono uppercase tracking-wider text-text-secondary">
            Latest
          </Badge>
        ) : isHealthy ? (
          <Badge variant="success" className="font-mono uppercase tracking-wider">
            Healthy
          </Badge>
        ) : snapshot.bugCount > 0 ? (
          <Badge
            variant="outline"
            className="border-status-critical/60 bg-status-critical/10 font-mono uppercase tracking-wider text-status-critical"
          >
            {snapshot.bugCount} {snapshot.bugCount === 1 ? "bug" : "bugs"}
          </Badge>
        ) : (
          <Badge variant="outline" className="font-mono uppercase tracking-wider text-text-tertiary">
            0 bugs
          </Badge>
        )}
        <span className="ml-auto font-mono text-2xs text-text-tertiary">{formatRelativeTime(snapshot.createdAt)}</span>
      </div>
      <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
      <span className="font-mono text-2xs text-text-tertiary">
        {formatCheckpointMetrics(snapshot.summary, snapshot.bugCount, snapshot.healthCounts.totalTests)}
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

type SeverityBadgeVariant = "critical" | "high" | "warn" | "secondary";

const SEVERITY_BADGE: Record<string, SeverityBadgeVariant> = {
  critical: "critical",
  high: "high",
  medium: "warn",
  low: "secondary",
};
