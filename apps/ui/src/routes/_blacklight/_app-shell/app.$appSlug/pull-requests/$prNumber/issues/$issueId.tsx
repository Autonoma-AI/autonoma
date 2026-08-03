import { createFileRoute } from "@tanstack/react-router";
import { AnalysisIssueDetailPage } from "components/analysis/issue-detail-page";
import { AnalysisIssueErrorState } from "components/analysis/issue-error-state";
import { ensureAnalysisIssueDetailData } from "lib/query/branches.queries";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/issues/$issueId")({
  loader: async ({ context, params: { issueId } }) => {
    await ensureAnalysisIssueDetailData(context.queryClient, issueId);
  },
  component: PrAnalysisIssuePage,
  errorComponent: AnalysisIssueErrorState,
});

function PrAnalysisIssuePage() {
  const { prNumber, issueId } = Route.useParams();
  return <AnalysisIssueDetailPage issueId={issueId} prNumber={prNumber} />;
}
