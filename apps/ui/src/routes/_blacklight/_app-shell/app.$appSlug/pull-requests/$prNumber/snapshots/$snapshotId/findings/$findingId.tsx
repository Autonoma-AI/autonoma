import type { InvestigationFinding } from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import { createFileRoute } from "@tanstack/react-router";
import { analysisVerdictMeta } from "components/analysis/verdict-meta";
import { FindingDetail } from "components/investigation/finding-detail";
import { useAnalysisReport } from "lib/query/branches.queries";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/findings/$findingId",
)({
  component: AnalysisFindingDetailPage,
});

function AnalysisFindingDetailPage() {
  const { prNumber, snapshotId, findingId } = Route.useParams();
  const { data } = useAnalysisReport(snapshotId);
  const backLink = <BackLink prNumber={prNumber} snapshotId={snapshotId} />;

  // A merged finding keeps only the canonical id as a route id, but a deep link (the PR comment) may reference
  // an absorbed test's slug - resolve those via coveredSlugs so they land on the finding that represents them.
  const finding = data?.findings.find((f) => f.id === findingId || (f.coveredSlugs ?? []).includes(findingId));

  if (finding == null) {
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <p className="rounded-lg border border-border-dim bg-surface-base px-5 py-6 text-sm text-text-secondary">
          This finding could not be found in the report.
        </p>
      </div>
    );
  }

  return (
    <FindingDetail
      finding={finding}
      meta={analysisVerdictMeta(finding.category)}
      backLink={backLink}
      issueLink={<IssueUpLink finding={finding} prNumber={prNumber} />}
    />
  );
}

// Link UP from a finding to the branch-scoped issue it was clustered into. Findings that carry no issue (a passing
// or coverage-plane check, or a run before the Reporter attributed it) render nothing.
function IssueUpLink({ finding, prNumber }: { finding: InvestigationFinding; prNumber: number }) {
  if (finding.issueId == null) return null;
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/issues/$issueId"
      params={{ prNumber, issueId: finding.issueId }}
      className="inline-flex items-center gap-1 self-start font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary"
    >
      <ArrowUpRightIcon size={12} />
      Part of issue{finding.issueTitle != null ? `: ${finding.issueTitle}` : ""}
    </AppLink>
  );
}

function BackLink({ prNumber, snapshotId }: { prNumber: number; snapshotId: string }) {
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
      params={{ prNumber, snapshotId }}
      aria-label="Back to the checkpoint report"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
    >
      <ArrowLeftIcon size={12} />
    </AppLink>
  );
}
