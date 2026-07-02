import {
  Badge,
  type ColumnDef,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Skeleton,
  SortableTable,
} from "@autonoma/blacklight";
import { Image } from "@phosphor-icons/react/Image";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { Play } from "@phosphor-icons/react/Play";
import { createFileRoute } from "@tanstack/react-router";
import { formatDate } from "lib/format";
import { useRunsPolling } from "lib/query/runs.queries";
import { Suspense, useState } from "react";
import { AppLink } from "../../-app-link";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/admin/runs")({
  component: RunsPage,
});

type RunStatus = "pending" | "running" | "success" | "failed";
type RunItem = ReturnType<typeof useRunsPolling>["data"][number];

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

function RunsContent() {
  const { data: runs } = useRunsPolling();
  const [search, setSearch] = useState("");

  const query = search.trim().toLowerCase();
  const filteredRuns = query === "" ? runs : runs.filter((run) => run.name.toLowerCase().includes(query));

  const columns: ColumnDef<RunItem, unknown>[] = [
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
      cell: ({ row }) => <span className="font-mono text-sm text-text-secondary">{row.original.duration ?? "-"}</span>,
    },
    {
      id: "startedAt",
      accessorKey: "startedAt",
      header: "Started",
      size: 160,
      enableSorting: true,
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-sm text-text-secondary">
          {row.original.startedAt != null ? formatDate(new Date(row.original.startedAt)) : "-"}
        </span>
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Panel className="min-h-0 flex-1">
        <PanelHeader className="flex items-center gap-2">
          <Play size={14} className="text-text-tertiary" />
          <PanelTitle>All runs</PanelTitle>
          <span className="ml-auto whitespace-nowrap font-mono text-2xs tabular-nums text-text-secondary">
            {filteredRuns.length} total
          </span>
          <div className="relative w-64 max-w-full">
            <MagnifyingGlassIcon
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary"
            />
            <Input
              type="search"
              placeholder="Filter by name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>
        </PanelHeader>

        <PanelBody className="min-h-0 flex-1 overflow-hidden p-0">
          <SortableTable
            virtualized
            estimatedRowHeight={57}
            data={filteredRuns}
            columns={columns}
            renderRow={(run, { rowProps, children }) => (
              <AppLink key={run.id} to="/app/$appSlug/runs/$runId" params={{ runId: run.id }} {...rowProps}>
                {children}
              </AppLink>
            )}
            emptyMessage={query === "" ? "No runs yet." : "No runs match your filter."}
          />
        </PanelBody>
      </Panel>
    </div>
  );
}

function ContentSkeleton() {
  return (
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
  );
}

function RunsPage() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-6 p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Runs</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">Admin-only: every run for this app.</p>
      </header>

      <Suspense fallback={<ContentSkeleton />}>
        <RunsContent />
      </Suspense>
    </div>
  );
}
