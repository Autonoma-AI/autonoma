import { createFileRoute, notFound } from "@tanstack/react-router";
import { AnalysisFixErrorState } from "components/analysis/fix/fix-page-states";
import { PrFixPage, PrFixPageSkeleton } from "components/analysis/fix/pr-fix-page";
import { ensureAnalysisForPrData } from "lib/query/branches.queries";
import { Suspense } from "react";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/fix")({
  loader: async ({ context, params: { appSlug, prNumber } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    await ensureAnalysisForPrData(context.queryClient, app.id, prNumber);
  },
  pendingComponent: PrFixPageSkeleton,
  errorComponent: ({ reset }) => <AnalysisFixErrorState reset={reset} />,
  component: PrFixRoute,
});

function PrFixRoute() {
  const { prNumber } = Route.useParams();

  return (
    <Suspense fallback={<PrFixPageSkeleton />}>
      <PrFixPage prNumber={prNumber} />
    </Suspense>
  );
}
