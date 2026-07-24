import { Button } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { WarningOctagonIcon } from "@phosphor-icons/react/WarningOctagon";
import { createFileRoute } from "@tanstack/react-router";
import { AnalysisIssueDetail, AnalysisIssueDetailSkeleton } from "components/analysis/issue-detail";
import { ensureAnalysisIssueDetailData, useAnalysisIssueDetail } from "lib/query/branches.queries";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/issues/$issueId")({
  loader: async ({ context, params: { issueId } }) => {
    await ensureAnalysisIssueDetailData(context.queryClient, issueId);
  },
  component: AnalysisIssueDetailPage,
  // Absence is handled by the page itself (the issue resolves to null -> graceful not-found). This boundary is the
  // last-resort net for an UNEXPECTED failure so the view degrades to a calm retry, not the app-wide crash screen.
  errorComponent: IssueErrorState,
});

function AnalysisIssueDetailPage() {
  const { prNumber, issueId } = Route.useParams();
  const { data: issue, isPending } = useAnalysisIssueDetail(issueId);

  if (isPending) return <AnalysisIssueDetailSkeleton />;

  if (issue == null) {
    return (
      <div className="flex flex-col gap-4">
        <AppLink
          to="/app/$appSlug/pull-requests/$prNumber"
          params={{ prNumber }}
          aria-label="Back to the pull request"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
        >
          <ArrowLeftIcon size={12} />
        </AppLink>
        <p className="rounded-lg border border-border-dim bg-surface-base px-5 py-6 text-sm text-text-secondary">
          This issue could not be found.
        </p>
      </div>
    );
  }

  return <AnalysisIssueDetail issue={issue} prNumber={prNumber} />;
}

function IssueErrorState({ reset }: { reset: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border-dim bg-surface-base px-6 py-12 text-center">
      <WarningOctagonIcon size={28} className="text-text-secondary" />
      <p className="text-sm text-text-secondary">We couldn&apos;t load this issue.</p>
      <Button variant="outline" size="xs" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
