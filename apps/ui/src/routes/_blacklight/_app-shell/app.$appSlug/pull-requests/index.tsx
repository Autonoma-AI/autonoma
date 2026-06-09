import {
  type ColumnDef,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  PrHealthPill,
  Skeleton,
  SortableTable,
} from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { createFileRoute } from "@tanstack/react-router";
import { useBranchDetail, useBranches, useSnapshotHistory } from "lib/query/branches.queries";
import { Suspense } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { useAppNavigate } from "../../-use-app-navigate";
import { PRHealthCell } from "./-components/pr-coverage-cell";
import { PRAuthorCell, PRNameCell, PRStateCell, PRUpdatedCell } from "./-components/pr-info-cells";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/")({
  component: PullRequestsPage,
});

type PullRequestRow = {
  id: string;
  prNumber: number;
  branchName: string;
  activeSnapshot: {
    status: string;
    _count: { testCaseAssignments: number };
    health: "healthy" | "critical" | "running" | "unknown";
  } | null;
};

function PullRequestsContent() {
  const app = useCurrentApplication();
  const { data: branches } = useBranches();
  const appNavigate = useAppNavigate();

  const rows: PullRequestRow[] = branches.flatMap((b) =>
    b.prNumber != null
      ? [
          {
            id: b.id,
            prNumber: b.prNumber,
            branchName: b.name,
            activeSnapshot: b.activeSnapshot,
          },
        ]
      : [],
  );

  function handleRowClick(row: PullRequestRow) {
    void appNavigate({
      to: "/app/$appSlug/pull-requests/$prNumber",
      params: { prNumber: String(row.prNumber) },
    });
  }

  const columns: ColumnDef<PullRequestRow, unknown>[] = [
    {
      id: "prNumber",
      accessorKey: "prNumber",
      header: "PR",
      size: 70,
      enableSorting: true,
      cell: ({ row }) => <span className="font-mono text-sm text-text-tertiary">#{row.original.prNumber}</span>,
    },
    {
      id: "name",
      accessorKey: "branchName",
      header: "Name",
      size: 420,
      enableSorting: false,
      cell: ({ row }) => (
        <PRNameCell applicationId={app.id} prNumber={row.original.prNumber} branchName={row.original.branchName} />
      ),
    },
    {
      id: "author",
      header: "Author",
      size: 140,
      enableSorting: false,
      cell: ({ row }) => <PRAuthorCell applicationId={app.id} prNumber={row.original.prNumber} />,
    },
    {
      id: "state",
      header: "State",
      size: 110,
      enableSorting: false,
      cell: ({ row }) => <PRStateCell applicationId={app.id} prNumber={row.original.prNumber} />,
    },
    {
      id: "updated",
      header: "Updated",
      size: 120,
      enableSorting: false,
      cell: ({ row }) => <PRUpdatedCell applicationId={app.id} prNumber={row.original.prNumber} />,
    },
    {
      id: "health",
      header: "Health",
      size: 140,
      enableSorting: false,
      cell: ({ row }) => <PRHealthCell activeSnapshot={row.original.activeSnapshot} />,
    },
  ];

  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <GitPullRequestIcon size={14} className="text-text-tertiary" />
        <PanelTitle>All pull requests</PanelTitle>
        <span className="ml-auto font-mono text-2xs text-text-tertiary">{rows.length} total</span>
      </PanelHeader>

      <PanelBody className="overflow-auto p-0">
        <SortableTable
          data={rows}
          columns={columns}
          onRowClick={handleRowClick}
          emptyMessage="No pull requests tracked yet."
        />
      </PanelBody>
    </Panel>
  );
}

function ContentSkeleton() {
  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <GitPullRequestIcon size={14} className="text-text-tertiary" />
        <PanelTitle>All pull requests</PanelTitle>
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

function MainBranchChip() {
  const app = useCurrentApplication();
  const { data: branch } = useBranchDetail(app.id, app.mainBranch.name);
  const { data: snapshots } = useSnapshotHistory(branch.id);
  const latest = [...snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const health = latest == null ? "unknown" : latest.bugCount > 0 ? "critical" : latest.health;

  return (
    <AppLink
      to="/app/$appSlug/pull-requests/main"
      className="inline-flex items-center gap-2 border border-border-dim bg-surface-base px-3 py-2 transition-colors hover:border-border-mid hover:bg-surface-raised"
    >
      <GitBranchIcon size={14} className="text-text-tertiary" />
      <span className="font-mono text-2xs uppercase tracking-widest text-text-secondary">main</span>
      <PrHealthPill health={health} />
      <ArrowRightIcon size={12} className="text-text-tertiary" />
    </AppLink>
  );
}

function PullRequestsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-text-primary">Pull Requests</h1>
          <p className="mt-1 font-mono text-xs text-text-secondary">Branches tracked by Autonoma, one entry per PR</p>
        </div>
        <Suspense fallback={<Skeleton className="h-9 w-44" />}>
          <MainBranchChip />
        </Suspense>
      </header>

      <Suspense fallback={<ContentSkeleton />}>
        <PullRequestsContent />
      </Suspense>
    </div>
  );
}
