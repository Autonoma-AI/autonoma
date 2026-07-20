import { Button } from "@autonoma/blacklight";
import { WarningOctagonIcon } from "@phosphor-icons/react/WarningOctagon";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { ensureAnalysisReportData } from "lib/query/branches.queries";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/findings",
)({
  loader: async ({ context, params: { snapshotId } }) => {
    await ensureAnalysisReportData(context.queryClient, snapshotId);
  },
  component: Outlet,
  // Absence is handled by the detail page itself (the report resolves to null, and the page renders a graceful
  // "not found" state). This boundary is the last-resort net for an UNEXPECTED failure (a network error) so the
  // finding view degrades to a calm retry instead of the app-wide "Something went wrong" crash screen.
  errorComponent: FindingErrorState,
});

function FindingErrorState({ reset }: { reset: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border-dim bg-surface-base px-6 py-12 text-center">
      <WarningOctagonIcon size={28} className="text-text-secondary" />
      <p className="text-sm text-text-secondary">We couldn&apos;t load this finding.</p>
      <Button variant="outline" size="xs" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
