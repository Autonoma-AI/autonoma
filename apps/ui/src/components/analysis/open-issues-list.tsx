import { Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import type { AnalysisIssueSummary } from "@autonoma/types";
import { IssueSummaryCard } from "components/analysis/issue-summary-card";

/**
 * The PR page's open-issues list. Bugs come first (their own group), then environment/scenario issues in a
 * secondary group; within each group the API has already ordered by descending severity. Each card links to the
 * PR-level issue-detail route (issues are branch-scoped, so the route lives above snapshots).
 */
export function AnalysisOpenIssuesList({ issues, prNumber }: { issues: AnalysisIssueSummary[]; prNumber: number }) {
  const bugs = issues.filter((issue) => issue.kind === "bug");
  const others = issues.filter((issue) => issue.kind !== "bug");

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Open issues</PanelTitle>
        <span className="font-mono text-2xs text-text-secondary">
          {issues.length} {issues.length === 1 ? "issue" : "issues"}
        </span>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-4">
        {issues.length === 0 ? (
          <p className="rounded-lg border border-border-dim bg-surface-void px-5 py-6 text-sm text-text-secondary">
            No open issues - everything the agent checked passed or was non-blocking.
          </p>
        ) : (
          <>
            {bugs.length > 0 && <IssueGroup title="Bugs" issues={bugs} prNumber={prNumber} />}
            {others.length > 0 && <IssueGroup title="Environment & scenario" issues={others} prNumber={prNumber} />}
          </>
        )}
      </PanelBody>
    </Panel>
  );
}

function IssueGroup({ title, issues, prNumber }: { title: string; issues: AnalysisIssueSummary[]; prNumber: number }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">{title}</h3>
      <ul className="flex flex-col gap-2">
        {issues.map((issue) => (
          <IssueSummaryCard key={issue.id} issue={issue} prNumber={prNumber} />
        ))}
      </ul>
    </div>
  );
}
