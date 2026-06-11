import { createFileRoute } from "@tanstack/react-router";
import { SnapshotChangesDetail } from "components/snapshot/snapshot-changes-detail";
import { buildSections } from "components/snapshot/snapshot-entries";
import { useSnapshotDetail } from "lib/query/branches.queries";
import { useMemo } from "react";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/changes/$testId",
)({
  component: ChangesDetailRoute,
});

function ChangesDetailRoute() {
  const { prNumber, snapshotId, testId } = Route.useParams();
  const { data } = useSnapshotDetail(snapshotId);
  const { changes, diffsJob, quarantinedTests, executedTests } = data;

  const entry = useMemo(() => {
    const sections = buildSections({
      changes,
      affectedTests: diffsJob.affectedTests,
      testCandidates: diffsJob.testCandidates,
      quarantinedTests,
      executedTests,
    });
    return sections.flatMap((s) => s.entries).find((e) => e.urlId === testId);
  }, [changes, diffsJob.affectedTests, diffsJob.testCandidates, quarantinedTests, executedTests, testId]);

  if (entry == null) {
    return (
      <div className="flex h-full items-center justify-center px-5 py-10">
        <p className="text-xs text-text-tertiary">Test not found in this checkpoint&apos;s changes.</p>
      </div>
    );
  }

  return <SnapshotChangesDetail entry={entry} prNumber={prNumber} />;
}
