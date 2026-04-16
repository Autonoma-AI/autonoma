import { createFileRoute, useParams } from "@tanstack/react-router";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { Suspense } from "react";
import { useCurrentApplication } from "../-use-current-application";
import { BugsChart, BugsChartSkeleton } from "./-home/bugs-chart";
import { LastGenerationsTable, LastGenerationsTableSkeleton } from "./-home/last-generations-table";
import { Milestones, MilestonesSkeleton } from "./-home/milestones";
import { RecentRunsTable, RecentRunsTableSkeleton } from "./-home/recent-runs-table";
import { TopSection, TopSectionSkeleton } from "./-home/top-section";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/")({
  loader: async ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) return;
    await Promise.all([
      ensureAPIQueryData(context.queryClient, trpc.tests.list.queryOptions({ applicationId: app.id })),
      ensureAPIQueryData(context.queryClient, trpc.generations.list.queryOptions({ applicationId: app.id })),
      ensureAPIQueryData(context.queryClient, trpc.runs.list.queryOptions({ applicationId: app.id })),
      ensureAPIQueryData(context.queryClient, trpc.bugs.list.queryOptions({ applicationId: app.id })),
    ]);
  },
  component: OverviewPage,
});

function OverviewPage() {
  const app = useCurrentApplication();
  const { appSlug } = useParams({ from: "/_blacklight/_app-shell/app/$appSlug" });

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Overview</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">Real-time health across your test suite</p>
      </header>

      <Suspense fallback={<MilestonesSkeleton />}>
        <Milestones applicationId={app.id} appSlug={appSlug} />
      </Suspense>

      <Suspense fallback={<TopSectionSkeleton />}>
        <TopSection />
      </Suspense>

      <Suspense fallback={<BugsChartSkeleton />}>
        <BugsChart />
      </Suspense>

      <div className="grid min-h-75 grid-cols-1 gap-6 lg:grid-cols-2">
        <Suspense fallback={<RecentRunsTableSkeleton />}>
          <RecentRunsTable />
        </Suspense>
        <Suspense fallback={<LastGenerationsTableSkeleton />}>
          <LastGenerationsTable />
        </Suspense>
      </div>
    </div>
  );
}
