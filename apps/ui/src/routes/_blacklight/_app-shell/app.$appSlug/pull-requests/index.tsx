import {
  type ColumnDef,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Skeleton,
  SortableTable,
} from "@autonoma/blacklight";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { createFileRoute } from "@tanstack/react-router";
import { useBranches } from "lib/query/branches.queries";
import { Suspense } from "react";
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

function PullRequestsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Pull Requests</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">Branches tracked by Autonoma, one entry per PR</p>
      </header>

      <Suspense fallback={<ContentSkeleton />}>
        <PullRequestsContent />
      </Suspense>
    </div>
  );
}
