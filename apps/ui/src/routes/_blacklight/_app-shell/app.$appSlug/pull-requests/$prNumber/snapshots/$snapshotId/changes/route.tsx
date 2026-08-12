import { Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { SnapshotChangesList } from "components/snapshot/snapshot-changes-list";
import { useSnapshotSections } from "components/snapshot/use-snapshot-sections";
import { useAnalysisJob, useSnapshotAnalysisState } from "lib/query/branches.queries";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/changes",
)({
  component: ChangesLayout,
});

function ChangesLayout() {
  const { snapshotId } = Route.useParams();
  const sections = useSnapshotSections(snapshotId);
  // A report-less authoritative run has no suite changes to show yet: the sections are empty and the raw plan diff
  // is deliberately withheld (a failed run's changes are discarded), so render the run's status instead.
  const { analyzed, settled } = useSnapshotAnalysisState(snapshotId);
  // The lifecycle is read for its status, to say whether the run failed or is still going.
  const { data: analysisJob } = useAnalysisJob(snapshotId);
  const awaitingReport = analyzed && !settled;

  const total = sections.reduce((sum, s) => sum + s.entries.length, 0);

  return (
    <Panel className="lg:h-full lg:min-h-0">
      <PanelHeader>
        <PanelTitle>Test suite changes</PanelTitle>
        <span className="font-mono text-2xs text-text-tertiary">
          {total} {total === 1 ? "test" : "tests"}
        </span>
      </PanelHeader>
      <PanelBody className="p-0 lg:min-h-0 lg:overflow-hidden">
        {awaitingReport ? (
          <ChangesRunStatus failed={analysisJob?.status === "failed"} />
        ) : total === 0 ? (
          <div className="px-5 py-8">
            <p className="text-xs text-text-tertiary">No test suite changes recorded for this checkpoint.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-px bg-border-dim lg:h-full lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:grid-rows-1">
            <div className="bg-surface-base lg:min-h-0 lg:overflow-y-auto">
              <SnapshotChangesList />
            </div>
            <div className="bg-surface-base lg:min-h-0 lg:overflow-y-auto">
              <Outlet />
            </div>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

// The changes-tab body for an authoritative run whose report has not landed. A failed run's suite changes were
// discarded (they are recomputed on the next push); a running one has none to show yet.
function ChangesRunStatus({ failed }: { failed: boolean }) {
  return (
    <div className="px-5 py-8">
      <p className="text-xs text-text-tertiary">
        {failed
          ? "The analysis run failed for this checkpoint, so its test suite changes were discarded. They will be recomputed on the next push."
          : "Analyzing this checkpoint. Test suite changes will appear here as soon as the run completes."}
      </p>
    </div>
  );
}
