import {
  type ColumnDef,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  PrHealthPill,
  Skeleton,
  SortableTable,
  Tabs,
  TabsList,
  TabsTrigger,
  cn,
} from "@autonoma/blacklight";
import type { PrPipelineStatus } from "@autonoma/types";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { createFileRoute, notFound } from "@tanstack/react-router";
import {
  INVESTIGATION_TONE_CLASS,
  type InvestigationPresence,
  type PullRequestStateFilter,
  ensureBranchesData,
  investigationEntryLabel,
  investigationEntryTone,
  useBranchDetail,
  useBranches,
  useInvestigationReportsBySnapshot,
  useSnapshotHistory,
} from "lib/query/branches.queries";
import { Suspense } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { useAppNavigate } from "../../-use-app-navigate";
import { PRHealthCell } from "./-components/pr-coverage-cell";
import { PRAuthorCell, PRNameCell, PRStateCell, PRUpdatedCell } from "./-components/pr-info-cells";

const PR_STATE_TABS: ReadonlyArray<{ value: PullRequestStateFilter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
];

const PR_STATE_TITLE: Record<PullRequestStateFilter, string> = {
  open: "Open pull requests",
  merged: "Merged pull requests",
  closed: "Closed pull requests",
};

function isPullRequestStateFilter(value: unknown): value is PullRequestStateFilter {
  return value === "open" || value === "closed" || value === "merged";
}

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/")({
  validateSearch: (search: Record<string, unknown>): { state: PullRequestStateFilter } => {
    if (isPullRequestStateFilter(search.state)) return { state: search.state };
    return { state: "open" };
  },
  loaderDeps: ({ search: { state } }) => ({ state }),
  loader: async ({ context, params: { appSlug }, deps: { state } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    await ensureBranchesData(context.queryClient, app.id, state);
  },
  pendingComponent: PullRequestsPageSkeleton,
  component: PullRequestsPage,
});

type PullRequestRow = {
  id: string;
  prNumber: number;
  branchName: string;
  prTitle?: string;
  prState?: "open" | "closed" | "merged";
  prAuthorLogin?: string;
  prUpdatedAt?: Date;
  snapshotId?: string;
  prStatus: PrPipelineStatus;
};

function PullRequestsContent({ state }: { state: PullRequestStateFilter }) {
  const { data: branches } = useBranches(state);
  const appNavigate = useAppNavigate();

  const rows: PullRequestRow[] = branches.flatMap((b) =>
    b.prNumber != null
      ? [
          {
            id: b.id,
            prNumber: b.prNumber,
            branchName: b.name,
            prTitle: b.pr.title,
            prState: b.pr.state,
            prAuthorLogin: b.pr.authorLogin,
            prUpdatedAt: b.pr.updatedAt,
            snapshotId: b.activeSnapshot?.id,
            prStatus: b.prStatus,
          },
        ]
      : [],
  );

  // Internal-only (@autonoma.app); disabled for everyone else, so the column below never renders for customers.
  const investigation = useInvestigationReportsBySnapshot(
    rows.map((row) => row.snapshotId).filter((id): id is string => id != null),
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
      cell: ({ row }) => <span className="font-mono text-sm text-text-secondary">#{row.original.prNumber}</span>,
    },
    {
      id: "name",
      accessorKey: "branchName",
      header: "Name",
      size: 420,
      enableSorting: false,
      cell: ({ row }) => <PRNameCell title={row.original.prTitle} branchName={row.original.branchName} />,
    },
    {
      id: "author",
      header: "Author",
      size: 140,
      enableSorting: false,
      cell: ({ row }) => <PRAuthorCell authorLogin={row.original.prAuthorLogin} />,
    },
    {
      id: "state",
      header: "State",
      size: 110,
      enableSorting: false,
      cell: ({ row }) => <PRStateCell state={row.original.prState} />,
    },
    {
      id: "updated",
      header: "Updated",
      size: 120,
      enableSorting: false,
      cell: ({ row }) => <PRUpdatedCell updatedAt={row.original.prUpdatedAt} />,
    },
    {
      id: "health",
      header: "Health",
      size: 140,
      enableSorting: false,
      cell: ({ row }) => <PRHealthCell status={row.original.prStatus} />,
    },
  ];

  // Internal-only column: reserved for the whole (internal) view - skeleton cells while the presence query
  // loads, then links or empty cells - so there is no post-load column reflow. Never renders for customers
  // (the hook is disabled for them, so `enabled` is false).
  if (investigation.enabled) {
    columns.push({
      id: "investigation",
      header: "Investigation",
      size: 130,
      enableSorting: false,
      cell: ({ row }) => (
        <PRInvestigationCell
          prNumber={row.original.prNumber}
          snapshotId={row.original.snapshotId}
          investigation={
            row.original.snapshotId != null ? investigation.bySnapshot.get(row.original.snapshotId) : undefined
          }
          loading={investigation.isLoading}
        />
      ),
    });
  }

  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <GitPullRequestIcon size={14} className="text-text-secondary" />
        <PanelTitle>{PR_STATE_TITLE[state]}</PanelTitle>
        <span className="ml-auto font-mono text-2xs text-text-secondary">{rows.length} total</span>
      </PanelHeader>

      <PanelBody className="overflow-auto p-0">
        <SortableTable
          data={rows}
          columns={columns}
          onRowClick={handleRowClick}
          emptyMessage={`No ${state} pull requests.`}
        />
      </PanelBody>
    </Panel>
  );
}

/**
 * Internal-only PR-list cell linking to the shadow investigation report for a PR. Nested inside a clickable
 * table row, so it stops propagation to win the click. Colored by severity (bug/warning/neutral); shows a
 * skeleton while the presence query loads, then the bug count or a "running" hint.
 */
function PRInvestigationCell({
  prNumber,
  snapshotId,
  investigation,
  loading,
}: {
  prNumber: number;
  snapshotId?: string;
  investigation?: InvestigationPresence;
  loading: boolean;
}) {
  if (investigation == null || snapshotId == null) {
    return loading ? <Skeleton className="h-3 w-16" /> : undefined;
  }
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/investigation"
      params={{ prNumber: String(prNumber), snapshotId }}
      onClick={(e) => e.stopPropagation()}
      aria-label={`Investigation report for PR #${prNumber}`}
      className={cn(
        "inline-flex items-center gap-1 font-mono text-2xs hover:underline",
        INVESTIGATION_TONE_CLASS[investigationEntryTone(investigation)],
      )}
    >
      <MagnifyingGlassIcon size={12} />
      {investigationEntryLabel(investigation)}
    </AppLink>
  );
}

function ContentSkeleton() {
  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <GitPullRequestIcon size={14} className="text-text-secondary" />
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

function PullRequestsPageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-text-primary">Pull Requests</h1>
          <p className="mt-1 font-mono text-xs text-text-secondary">Branches tracked by Autonoma, one entry per PR</p>
        </div>
        <Skeleton className="h-9 w-44" />
      </header>

      <Tabs value="open">
        <TabsList variant="line">
          {PR_STATE_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <ContentSkeleton />
    </div>
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
      <GitBranchIcon size={14} className="text-text-secondary" />
      <span className="font-mono text-2xs uppercase tracking-widest text-text-secondary">main</span>
      <PrHealthPill health={health} />
      <ArrowRightIcon size={12} className="text-text-secondary" />
    </AppLink>
  );
}

function PullRequestsPage() {
  const { state } = Route.useSearch();
  const navigate = Route.useNavigate();

  function handleTabChange(value: unknown) {
    if (!isPullRequestStateFilter(value)) return;
    void navigate({ search: { state: value } });
  }

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

      <Tabs value={state} onValueChange={handleTabChange}>
        <TabsList variant="line">
          {PR_STATE_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Suspense key={state} fallback={<ContentSkeleton />}>
        <PullRequestsContent state={state} />
      </Suspense>
    </div>
  );
}
