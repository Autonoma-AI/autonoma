import { Tabs, TabsList, TabsTrigger } from "@autonoma/blacklight";
import { Link } from "@tanstack/react-router";

/** The Checkpoint report / Test suite changes tab bar, shared by the diffs and authoritative page layouts. */
export function SnapshotReportTabs({
  appSlug,
  prNumber,
  snapshotId,
  activeTab,
}: {
  appSlug: string;
  prNumber: number;
  snapshotId: string;
  activeTab: "report" | "changes";
}) {
  return (
    <Tabs value={activeTab} className="gap-4">
      <TabsList variant="line">
        <TabsTrigger
          value="report"
          render={
            <Link
              to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
              params={{ appSlug, prNumber, snapshotId }}
            />
          }
        >
          Checkpoint report
        </TabsTrigger>
        <TabsTrigger
          value="changes"
          render={
            <Link
              to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/changes"
              params={{ appSlug, prNumber, snapshotId }}
            />
          }
        >
          Test suite changes
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
