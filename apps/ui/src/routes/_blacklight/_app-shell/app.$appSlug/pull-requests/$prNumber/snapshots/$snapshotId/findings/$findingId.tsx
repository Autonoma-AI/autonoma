import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
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

  return <FindingDetail finding={finding} meta={analysisVerdictMeta(finding.category)} backLink={backLink} />;
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
