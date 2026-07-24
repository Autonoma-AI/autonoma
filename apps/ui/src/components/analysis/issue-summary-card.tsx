import { Badge } from "@autonoma/blacklight";
import type { AnalysisIssueSummary } from "@autonoma/types";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { analysisIssueKindMeta, analysisIssueSeverityMeta } from "components/analysis/issue-meta";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

/**
 * One issue rendered as a card linking to the PR-level issue-detail route (issues are branch-scoped, so the route
 * lives above snapshots). Shared by the PR open-issues list and the snapshot per-job issue-set changes.
 */
export function IssueSummaryCard({ issue, prNumber }: { issue: AnalysisIssueSummary; prNumber: number }) {
  const kindMeta = analysisIssueKindMeta(issue.kind);
  const severityMeta = analysisIssueSeverityMeta(issue.severity);

  return (
    <li>
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/issues/$issueId"
        params={{ prNumber, issueId: issue.id }}
        className="flex items-center gap-3 rounded-lg border border-border-dim bg-surface-void px-4 py-3 transition-colors hover:border-border-mid hover:bg-surface-raised"
      >
        {issue.thumbnailUrl != null ? (
          <img
            src={issue.thumbnailUrl}
            alt=""
            className="h-12 w-20 shrink-0 rounded border border-border-mid object-cover"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={kindMeta.variant} className="font-mono uppercase">
              {kindMeta.label}
            </Badge>
            <Badge variant={severityMeta.variant} className="font-mono uppercase">
              {severityMeta.label}
            </Badge>
          </div>
          <p className="mt-1 truncate text-sm text-text-primary">{issue.title}</p>
          {issue.runCount > 0 && (
            <p className="truncate font-mono text-2xs text-text-secondary">
              seen in {issue.runCount} {issue.runCount === 1 ? "run" : "runs"}
            </p>
          )}
        </div>
        <CaretRightIcon size={14} className="shrink-0 text-text-secondary" />
      </AppLink>
    </li>
  );
}
