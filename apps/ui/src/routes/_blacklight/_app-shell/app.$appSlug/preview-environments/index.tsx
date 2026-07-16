import {
  Badge,
  Button,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  Skeleton,
} from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { BrowsersIcon } from "@phosphor-icons/react/Browsers";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { formatRelativeTime } from "lib/format";
import { ensureActivePreviewEnvironmentsData, useActivePreviewEnvironments } from "lib/query/deployments.queries";
import type { RouterOutputs } from "lib/trpc";
import { Suspense } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { PREVIEW_STATUS_META } from "../pull-requests/-components/preview-status-meta";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/preview-environments/")({
  loader: async ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    await ensureActivePreviewEnvironmentsData(context.queryClient, app.id);
  },
  pendingComponent: PreviewEnvironmentsPageSkeleton,
  component: PreviewEnvironmentsPage,
});

type PreviewEnvironment = RouterOutputs["deployments"]["listActiveForApp"][number];

// Reconciled environment health -> shared status badge metadata. `health` is
// rolled up server-side from the per-app statuses so the headline never
// contradicts the app rows on the environment's detail page.
const HEALTH_META: Record<
  PreviewEnvironment["health"],
  (typeof PREVIEW_STATUS_META)[keyof typeof PREVIEW_STATUS_META]
> = {
  ready: PREVIEW_STATUS_META.ready,
  building: PREVIEW_STATUS_META.building,
  degraded: PREVIEW_STATUS_META.degraded,
  failed: PREVIEW_STATUS_META.failed,
  unknown: PREVIEW_STATUS_META.unknown,
};

function PreviewEnvironmentsPage() {
  return (
    <section className="flex-1 overflow-auto p-6 lg:p-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <PreviewEnvironmentsHeader />
        <Suspense fallback={<TableSkeleton />}>
          <EnvironmentsTable />
        </Suspense>
      </div>
    </section>
  );
}

function PreviewEnvironmentsHeader() {
  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-text-secondary">
        <BrowsersIcon size={16} />
        <span className="font-mono text-2xs uppercase tracking-widest">Preview Environments</span>
      </div>
      <h1 className="text-xl font-medium tracking-tight text-text-primary">Preview environments</h1>
      <p className="text-xs text-text-secondary">
        Active preview environments for this app, one per open pull request. Open one to see each service's status and
        live URL.
      </p>
    </header>
  );
}

function EnvironmentsTable() {
  const app = useCurrentApplication();
  const { data: environments } = useActivePreviewEnvironments(app.id);

  if (environments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-dim py-16 text-center">
        <BrowsersIcon size={28} className="text-text-secondary" />
        <p className="text-sm text-text-primary">No active preview environments</p>
        <p className="max-w-sm text-xs text-text-secondary">
          Open a pull request to spin up a preview environment. It will appear here while it is live.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border-dim">
      <DataTable>
        <DataTableHead>
          <DataTableRow>
            <DataTableHeaderCell className="pl-3">Environment</DataTableHeaderCell>
            <DataTableHeaderCell>Health</DataTableHeaderCell>
            <DataTableHeaderCell>Apps</DataTableHeaderCell>
            <DataTableHeaderCell>Updated</DataTableHeaderCell>
            <DataTableHeaderCell align="right" className="pr-3" />
          </DataTableRow>
        </DataTableHead>
        <DataTableBody>
          {environments.map((environment) => (
            <EnvironmentRow key={environment.id} environment={environment} />
          ))}
        </DataTableBody>
      </DataTable>
    </div>
  );
}

function EnvironmentRow({ environment }: { environment: PreviewEnvironment }) {
  const healthMeta = HEALTH_META[environment.health];
  const readyCount = environment.apps.filter((app) => app.status === "ready").length;

  return (
    <DataTableRow>
      <DataTableCell className="pl-3">
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-2xs text-text-primary">PR #{environment.prNumber}</span>
          <span className="flex items-center gap-1.5 font-mono text-3xs text-text-secondary">
            <GitBranchIcon size={11} className="shrink-0" />
            <span className="block max-w-xs truncate">{environment.headRef}</span>
          </span>
        </div>
      </DataTableCell>
      <DataTableCell>
        <Badge variant={healthMeta.badge} className="text-3xs" title={environment.phase ?? environment.status}>
          {healthMeta.label}
        </Badge>
      </DataTableCell>
      <DataTableCell>
        <span className="font-mono text-2xs text-text-secondary">
          {readyCount}/{environment.apps.length}
        </span>
      </DataTableCell>
      <DataTableCell>
        <span className="whitespace-nowrap font-mono text-3xs text-text-secondary">
          {formatRelativeTime(environment.updatedAt)}
        </span>
      </DataTableCell>
      <DataTableCell align="right" className="pr-3">
        {environment.prNumber > 0 ? (
          <Button
            variant="outline"
            size="xs"
            render={
              <AppLink to="/app/$appSlug/pull-requests/$prNumber/preview" params={{ prNumber: environment.prNumber }} />
            }
          >
            View
            <ArrowRightIcon size={12} />
          </Button>
        ) : (
          // The main-branch environment (PR 0) has no pull request, so its preview lives on the main-branch page.
          <Button variant="outline" size="xs" render={<AppLink to="/app/$appSlug/pull-requests/main" />}>
            View
            <ArrowRightIcon size={12} />
          </Button>
        )}
      </DataTableCell>
    </DataTableRow>
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-dim p-2">
      {[1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function PreviewEnvironmentsPageSkeleton() {
  return (
    <section className="flex-1 overflow-auto p-6 lg:p-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
        <TableSkeleton />
      </div>
    </section>
  );
}
