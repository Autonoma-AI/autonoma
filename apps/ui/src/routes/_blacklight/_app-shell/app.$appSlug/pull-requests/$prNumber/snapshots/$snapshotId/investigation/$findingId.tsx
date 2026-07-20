import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { createFileRoute } from "@tanstack/react-router";
import { findingCategoryMeta } from "components/investigation/finding-category";
import { FindingDetail, FindingDetailSkeleton } from "components/investigation/finding-detail";
import { useInvestigationReportData } from "lib/query/branches.queries";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/investigation/$findingId",
)({
  component: FindingDetailPage,
});

function FindingDetailPage() {
  const { prNumber, snapshotId, findingId } = Route.useParams();
  const { data, isPending } = useInvestigationReportData(snapshotId);
  const backLink = <BackLink prNumber={prNumber} snapshotId={snapshotId} />;

  if (isPending) return <FindingDetailSkeleton />;

  // Reconciliation can absorb a test's finding into a canonical one (only the canonical's id survives as a
  // route id), but external deep links (the PR comment) reference the test's own slug - resolve those to the
  // merged finding via coveredSlugs so they land on the finding that now represents that test.
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
      meta={findingCategoryMeta(finding.category)}
      backLink={backLink}
      repoFullName={data?.repoFullName}
      commitSha={data?.commitSha}
    />
  );
}

function BackLink({ prNumber, snapshotId }: { prNumber: number; snapshotId: string }) {
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/investigation"
      params={{ prNumber, snapshotId }}
      aria-label="Back to findings"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
    >
      <ArrowLeftIcon size={12} />
    </AppLink>
  );
}
