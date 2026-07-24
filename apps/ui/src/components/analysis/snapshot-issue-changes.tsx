import { Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import type { AnalysisIssueSummary } from "@autonoma/types";
import { IssueSummaryCard } from "components/analysis/issue-summary-card";
import { useAnalysisSnapshotIssueChanges } from "lib/query/branches.queries";

/**
 * The per-job issue-set changes for a snapshot's analysis run: which branch issues this checkpoint opened, carried
 * forward from an earlier run, or resolved. Renders nothing when the run touched no issues, so a clean checkpoint
 * stays quiet.
 */
export function SnapshotIssueChanges({ snapshotId, prNumber }: { snapshotId: string; prNumber: number }) {
  const { data } = useAnalysisSnapshotIssueChanges(snapshotId);

  const groups: { key: string; title: string; issues: AnalysisIssueSummary[] }[] = [
    { key: "opened", title: "Opened this checkpoint", issues: data.opened },
    { key: "carried", title: "Carried forward", issues: data.carriedForward },
    { key: "resolved", title: "Resolved this checkpoint", issues: data.resolved },
  ].filter((group) => group.issues.length > 0);

  if (groups.length === 0) return null;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Issues this checkpoint</PanelTitle>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-2">
            <h3 className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
              {group.title} · {group.issues.length}
            </h3>
            <ul className="flex flex-col gap-2">
              {group.issues.map((issue) => (
                <IssueSummaryCard key={issue.id} issue={issue} prNumber={prNumber} />
              ))}
            </ul>
          </div>
        ))}
      </PanelBody>
    </Panel>
  );
}

export function SnapshotIssueChangesSkeleton() {
  return <Skeleton className="h-40 w-full" />;
}
