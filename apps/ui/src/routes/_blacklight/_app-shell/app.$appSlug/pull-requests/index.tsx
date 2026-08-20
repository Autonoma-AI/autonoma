import {
  cn,
  EmptyState,
  Pagination,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Skeleton,
  SortableTable,
  TableSkeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@autonoma/blacklight";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { IsolatedErrorBoundary } from "components/isolated-error-boundary";
import { RouteErrorState } from "components/route-error-state";
import { toPageParam } from "lib/page-param";
import { useApplicationActivity } from "lib/query/activity.queries";
import { useShellSuiteHealth } from "lib/query/app-shell.queries";
import {
  ensureBranchesData,
  ensureMainOpenProblemsData,
  type PullRequestStateFilter,
  useBranches,
} from "lib/query/branches.queries";
import { useApplicationPreviewLiveness } from "lib/query/preview-access.queries";
import { type ReactNode, Suspense } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { SuiteHealthCard } from "routes/_blacklight/_app-shell/-layout/suite-health-meter";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { FirstRunBody, isInFlightPipelineKind } from "./-components/first-run-body";
import { MainProblemsRail, MainProblemsRailSkeleton } from "./-components/main-problems-rail";
import { PR_EMPTY_DESCRIPTION } from "./-components/pr-empty-state-copy";
import { prListColumns } from "./-components/pr-list-columns";
import type { PullRequestRow } from "./-components/pull-request-row";
import { VigilBody } from "./-components/vigil-body";

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

/**
 * A preview URL only if the pull request is still open.
 *
 * `branches.list` cannot be trusted for this. It drops a previewkit environment once that environment reports
 * `torn_down` or `failed`, but the legacy `branchDeployment` path it falls back to has no state filter at all -
 * that URL is returned for as long as the row exists, so merged and closed pull requests kept a Preview column
 * pointing at an environment that is gone. Even on the previewkit path there is a window between a merge and
 * the tear-down actually running.
 *
 * Filtering here rather than in the service because `branches.service.ts` is being rewritten by #2001/#2056 and
 * is off limits to this branch. The server-side fix belongs with that work: the legacy join wants the same
 * exclusion the previewkit query already has.
 */
function previewUrlFor(prState: PullRequestRow["prState"], previewUrl: string | null | undefined): string | undefined {
  if (prState !== "open") return undefined;
  return previewUrl ?? undefined;
}

interface PullRequestsSearch {
  state: PullRequestStateFilter;
  page?: number;
}

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/")({
  // Everything but `state` is omitted at its default, so the common URL stays `?state=open` and every existing
  // link keeps working.
  validateSearch: (search: Record<string, unknown>): PullRequestsSearch => {
    const state = isPullRequestStateFilter(search.state) ? search.state : "open";
    const page = toPageParam(search.page);
    return { state, page: page > 1 ? page : undefined };
  },
  loaderDeps: ({ search: { state, page } }) => ({ state, page: page ?? 1 }),
  loader: async ({ context, params: { appSlug }, deps: { state, page } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    await Promise.all([
      ensureBranchesData(context.queryClient, app.id, state, page),
      ensureMainOpenProblemsData(context.queryClient, app.id),
    ]);
  },
  pendingComponent: PullRequestsPageSkeleton,
  errorComponent: PullRequestsError,
  component: PullRequestsPage,
});

/**
 * The heading comes from the route context the shell already resolved, so a failed list still says which
 * application you are looking at. The tabs stay live because each is a separate query: the one that failed
 * says so, and the other two are a click away rather than behind a retry that has to succeed first.
 */
function PullRequestsError({ reset }: { reset: () => void }) {
  const { state } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <PullRequestsFrame>
      <PullRequestsHeader />
      <PullRequestsStateTabs
        value={state}
        onValueChange={(value) => {
          if (!isPullRequestStateFilter(value)) return;
          void navigate({ search: { state: value, page: undefined } });
        }}
      />
      <RouteErrorState message="We couldn't load this application's pull requests." reset={reset} />
    </PullRequestsFrame>
  );
}

function PullRequestsContent({ state, page }: { state: PullRequestStateFilter; page: number }) {
  const app = useCurrentApplication();
  const { data: branches } = useBranches(state, page);
  const activity = useApplicationActivity();
  // Only the Open tab: a repository with no pull requests at all trivially has none merged or closed either, and
  // explaining the loop three times over is noise.
  const isZero = !activity.hasEverOpenedPullRequest && state === "open";
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const pageCount = Math.max(1, Math.ceil(branches.totalCount / branches.pageSize));
  // The server clamps an over-run page, so this is the page on screen - which is not always the one in the URL.
  const servedPage = branches.page;

  const rows: PullRequestRow[] = branches.items.flatMap((b) =>
    b.prNumber != null
      ? [
          {
            id: b.id,
            prNumber: b.prNumber,
            branchName: b.name,
            baseBranchName: app.mainBranch.name,
            createdAt: b.createdAt,
            testCount: b.activeSnapshot?._count.testCaseAssignments ?? 0,
            prStatus: b.prStatus,
            prTitle: b.pr.title,
            prState: b.pr.state,
            prAuthorLogin: b.pr.authorLogin,
            prUpdatedAt: b.pr.updatedAt,
            snapshotId: b.activeSnapshot?.id,
            previewUrl: previewUrlFor(b.pr.state, b.previewUrl),
          },
        ]
      : [],
  );

  // One liveness poll covering every preview the app has (read-only, never wakes them).
  const { data: liveness } = useApplicationPreviewLiveness();
  // Already fetched for the card on this page, so this is the cache rather than another request.
  const { data: suiteHealth } = useShellSuiteHealth();

  // The first run, while it is still going. `evidence.runs` counts runs that reached a verdict, so zero means
  // nothing has settled yet - `hasEverRun` cannot answer this, because `firstRunAt` counts a snapshot from the
  // moment a run is TRIGGERED and is therefore already true while the very first one is still building.
  const firstRunInFlight =
    suiteHealth.evidence.runs === 0 ? rows.find((row) => isInFlightPipelineKind(row.prStatus.kind)) : undefined;

  // Asked of the rows rather than of the tab, so it holds for a list that mixes states and answers itself for
  // an application with no previews at all.
  const hasPreviews = rows.some((row) => row.previewUrl != null);
  const columns = prListColumns({ hasPreviews, liveness });

  return (
    <Panel className="min-h-0">
      <PanelHeader className="flex items-center gap-2">
        <GitPullRequestIcon size={14} className="text-text-secondary" />
        <PanelTitle>{PR_STATE_TITLE[state]}</PanelTitle>
        <span className="ml-auto font-mono text-2xs text-text-secondary">
          {branches.totalCount} total · most recently updated
        </span>
      </PanelHeader>

      {/* `min-h-0` is what lets this be the scroller: `Panel` is a flex column, so without it the body's
          content sets the panel's height and the page grows instead - twenty-five rows pushed the pager a
          screen and a half below the fold. Bounded, the rows scroll under a heading and a pager that stay. */}
      <PanelBody className="min-h-0 overflow-auto p-0">
        {firstRunInFlight != null && isInFlightPipelineKind(firstRunInFlight.prStatus.kind) && (
          <FirstRunBody kind={firstRunInFlight.prStatus.kind} prNumber={firstRunInFlight.prNumber} />
        )}
        {rows.length === 0 && isZero ? (
          // Nothing has EVER run here, which the empty state below cannot say: it reports a count, and a count of
          // zero on a repository that has never been touched reads as "you failed to fill this".
          <VigilBody activity={activity} />
        ) : rows.length === 0 ? (
          <EmptyState
            className="border-0 bg-transparent"
            icon={<GitPullRequestIcon size={32} />}
            title={`No ${state} pull requests`}
            description={PR_EMPTY_DESCRIPTION[state]}
          />
        ) : (
          <SortableTable
            data={rows}
            columns={columns}
            // A real anchor rather than an onClick handler, so cmd/middle-click opens a PR in a new tab and the
            // browser can show and copy its URL. It is absolutely positioned, so it takes no grid column, and
            // the links nested inside the row raise themselves above it.
            renderRow={(row, { rowProps, children }) => (
              <div key={row.id} {...rowProps} className={cn(rowProps.className, "relative")}>
                <AppLink
                  to="/app/$appSlug/pull-requests/$prNumber"
                  params={{ prNumber: String(row.prNumber) }}
                  aria-label={`Pull request #${row.prNumber}`}
                  className="absolute inset-0"
                />
                {children}
              </div>
            )}
          />
        )}
      </PanelBody>

      <Pagination
        page={servedPage}
        pageCount={pageCount}
        // Replaces rather than pushes: paging is browsing one list, not a place worth a back-button stop each time.
        onPageChange={(next) => void navigate({ search: { ...search, page: next }, replace: true })}
        label={`${rows.length} of ${branches.totalCount}`}
      />
    </Panel>
  );
}

function ContentSkeleton() {
  return (
    <Panel className="min-h-0">
      <PanelHeader className="flex items-center gap-2">
        <GitPullRequestIcon size={14} className="text-text-secondary" />
        <PanelTitle>Pull requests</PanelTitle>
      </PanelHeader>
      <PanelBody className="p-4">
        {/* The panel's own chrome is painted for real above; only the rows are unknown. */}
        <TableSkeleton rowClassName="h-12" />
      </PanelBody>
    </Panel>
  );
}

/**
 * The page's frame, shared by the settled page, its skeleton and its error state so none of the three shifts
 * into another.
 *
 * `h-full` makes the table the thing that scrolls rather than the page: the panel's heading, the state tabs
 * and the pager stay on screen while the rows move under them. Left to grow, twenty-five rows put the pager
 * a screen and a half down, which is a strange place for the control that changes which rows you are reading.
 */
function PullRequestsFrame({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col gap-6 overflow-hidden">{children}</div>;
}

function PullRequestsHeader({ children }: { children?: ReactNode }) {
  const app = useCurrentApplication();
  return (
    <header className="flex shrink-0 flex-wrap items-start justify-between gap-3">
      {/* The heading names the page, not the application: the switcher in the bar already says which
          application you are in, and repeating it here spent the largest text on screen on something stated
          two inches above it. The architecture stays, because this is the only place the product says it. */}
      <div>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Pull requests</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">
          {app.architecture.toLowerCase()} · every pull request Autonoma is tracking, one entry each
        </p>
      </div>
      {children}
    </header>
  );
}

/**
 * The state filter, shared by the page, its skeleton and its error state - all three show it, because which
 * lists exist is a fact about the application rather than about the request that just failed.
 */
function PullRequestsStateTabs({
  value,
  onValueChange,
}: {
  value: PullRequestStateFilter;
  onValueChange?: (value: unknown) => void;
}) {
  return (
    <Tabs value={value} onValueChange={onValueChange} className="shrink-0">
      <TabsList variant="line">
        {PR_STATE_TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function PullRequestsPageSkeleton() {
  return (
    <PullRequestsFrame>
      <PullRequestsHeader>
        <Skeleton className="h-16 w-72" />
      </PullRequestsHeader>

      <PullRequestsStateTabs value="open" />

      <ContentSkeleton />
    </PullRequestsFrame>
  );
}

function PullRequestsPage() {
  const { state, page = 1 } = Route.useSearch();
  const navigate = Route.useNavigate();

  function handleTabChange(value: unknown) {
    if (!isPullRequestStateFilter(value)) return;
    // Back to page 1: the tabs are different lists, and page 7 of "open" means nothing in "merged".
    void navigate({ search: { state: value, page: undefined } });
  }

  return (
    <PullRequestsFrame>
      <PullRequestsHeader>
        <SuiteHealthCard />
      </PullRequestsHeader>

      <PullRequestsStateTabs value={state} onValueChange={handleTabChange} />

      {/* Stretch stays on for the row as a whole: the table column has to reach the full height for its panel
          body to be the thing that scrolls. The rail opts out of it individually with `self-start`, which is
          what keeps the two columns ending at their own content instead of one running to the fold. */}
      <div className="flex min-h-0 flex-1 gap-6">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Suspense key={`${state}:${page}`} fallback={<ContentSkeleton />}>
            <PullRequestsContent state={state} page={page} />
          </Suspense>
        </div>

        {/* Isolated: the table is what this route is for, and the aside failing must not replace a working
            list with a retry screen. */}
        <IsolatedErrorBoundary
          fallback={(retry) => (
            <aside className="w-85 shrink-0 self-start">
              <RouteErrorState message="We couldn't load what's unresolved on main." reset={retry} />
            </aside>
          )}
        >
          <Suspense fallback={<MainProblemsRailSkeleton />}>
            <MainProblemsRail />
          </Suspense>
        </IsolatedErrorBoundary>
      </div>
    </PullRequestsFrame>
  );
}
