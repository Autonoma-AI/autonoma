import {
  Badge,
  type ColumnDef,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Skeleton,
  SortableTable,
} from "@autonoma/blacklight";
import { Image } from "@phosphor-icons/react/Image";
import { Play } from "@phosphor-icons/react/Play";
import { createFileRoute } from "@tanstack/react-router";
import { formatDate } from "lib/format";
import { useRuns } from "lib/query/runs.queries";
import { Suspense, useMemo } from "react";
import { AppLink } from "../../-app-link";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/runs/")({
  component: RunsPage,
});

type RunStatus = "pending" | "running" | "success" | "failed";
type RunItem = ReturnType<typeof useRuns>["data"][number];

function toRunBadgeVariant(status: RunStatus) {
  switch (status) {
    case "success":
      return "success" as const;
    case "failed":
      return "critical" as const;
    case "running":
      return "status-running" as const;
    case "pending":
      return "status-pending" as const;
  }
}

function toRunStatusLabel(status: RunStatus) {
  switch (status) {
    case "success":
      return "Passed";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "pending":
      return "Pending";
  }
}

function ScreenshotPlaceholder() {
  return (
    <div className="flex aspect-video w-full items-center justify-center bg-surface-raised">
      <Image size={32} className="text-text-tertiary opacity-30" />
    </div>
  );
}

function RecentRunScreenshots({ runs }: { runs: RunItem[] }) {
  const recentRuns = runs.slice(0, 2);

  if (recentRuns.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {recentRuns.map((run, index) => (
        <AppLink
          key={run.id}
          to="/app/$appSlug/runs/$runId"
          params={{ runId: run.id }}
          className="group block cursor-pointer border border-border-dim bg-surface-base transition-colors hover:border-border-mid"
        >
          <div className="overflow-hidden">
            {run.lastScreenshot != null ? (
              <img
                src={run.lastScreenshot}
                alt={`Run ${index + 1} screenshot`}
                className="aspect-video w-full object-cover object-top transition-transform group-hover:scale-[1.02]"
              />
            ) : (
              <ScreenshotPlaceholder />
            )}
          </div>
          <div className="flex items-center justify-between border-t border-border-dim px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="truncate text-xs font-medium text-text-primary">{run.name}</span>
              <Badge variant={toRunBadgeVariant(run.status as RunStatus)} className="text-3xs">
                {toRunStatusLabel(run.status as RunStatus)}
              </Badge>
            </div>
            <span className="font-mono text-2xs text-text-tertiary">{run.shortId}</span>
          </div>
        </AppLink>
      ))}
    </div>
  );
}

function RunsContent() {
  const { data: runs } = useRuns();

  const columns = useMemo<ColumnDef<RunItem, unknown>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Test name",
        size: 400,
        enableSorting: true,
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-3">
            {row.original.lastScreenshot != null ? (
              <img
                src={row.original.lastScreenshot}
                alt=""
                className="hidden h-10 w-16 shrink-0 border border-border-dim object-cover object-top sm:block"
              />
            ) : (
              <div className="hidden h-10 w-16 shrink-0 items-center justify-center border border-border-dim bg-surface-raised sm:flex">
                <Image size={14} className="text-text-tertiary opacity-30" />
              </div>
            )}
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-text-primary">{row.original.name}</span>
                <span className="shrink-0 font-mono text-2xs text-text-tertiary">{row.original.shortId}</span>
              </div>
              {row.original.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {row.original.tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-2xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        size: 120,
        enableSorting: true,
        cell: ({ row }) => (
          <Badge variant={toRunBadgeVariant(row.original.status as RunStatus)}>
            {toRunStatusLabel(row.original.status as RunStatus)}
          </Badge>
        ),
      },
      {
        id: "steps",
        accessorKey: "stepCount",
        header: "Steps",
        size: 80,
        enableSorting: true,
        cell: ({ row }) => <span className="text-sm text-text-secondary">{row.original.stepCount}</span>,
      },
      {
        id: "duration",
        accessorKey: "duration",
        header: "Duration",
        size: 120,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-sm text-text-secondary">{row.original.duration ?? "\u2014"}</span>
        ),
      },
      {
        id: "startedAt",
        accessorKey: "startedAt",
        header: "Started",
        size: 160,
        enableSorting: true,
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-sm text-text-secondary">
            {row.original.startedAt != null ? formatDate(new Date(row.original.startedAt)) : "\u2014"}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-6">
      <RecentRunScreenshots runs={runs} />

      <Panel>
        <PanelHeader className="flex items-center gap-2">
          <Play size={14} className="text-text-tertiary" />
          <PanelTitle>All runs</PanelTitle>
          <span className="ml-auto font-mono text-2xs text-text-tertiary">{runs.length} total</span>
        </PanelHeader>

        <PanelBody className="overflow-auto p-0">
          <SortableTable
            data={runs}
            columns={columns}
            renderRow={(run, { className, children }) => (
              <AppLink
                key={run.id}
                to="/app/$appSlug/runs/$runId"
                params={{ runId: run.id }}
                className={`table-row cursor-pointer ${className}`}
              >
                {children}
              </AppLink>
            )}
            emptyMessage="No runs yet - trigger your first one from a test."
          />
        </PanelBody>
      </Panel>
    </div>
  );
}

function ContentSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {["sk-img-1", "sk-img-2"].map((id) => (
          <Skeleton key={id} className="aspect-video w-full" />
        ))}
      </div>
      <Panel>
        <PanelHeader className="flex items-center gap-2">
          <Play size={14} className="text-text-tertiary" />
          <PanelTitle>All runs</PanelTitle>
        </PanelHeader>
        <PanelBody className="p-4">
          <div className="flex flex-col gap-3">
            {["sk-1", "sk-2", "sk-3", "sk-4", "sk-5"].map((id) => (
              <Skeleton key={id} className="h-10 w-full" />
            ))}
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}

function RunsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Runs</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">View all test run executions</p>
      </header>

      <Suspense fallback={<ContentSkeleton />}>
        <RunsContent />
      </Suspense>
    </div>
  );
}
