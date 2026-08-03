import { createFileRoute } from "@tanstack/react-router";
import { AnalysisIssueDetailPage } from "components/analysis/issue-detail-page";
import { AnalysisIssueErrorState } from "components/analysis/issue-error-state";
import { ensureAnalysisIssueDetailData } from "lib/query/branches.queries";

/**
 * The branch-agnostic analysis-issue route, for issues reached from a surface that has no pull request to route
 * through - main's open problems. Issue ids are globally unique, so the read needs nothing but the id. The
 * PR-scoped route stays for issues reached from a pull request, where each finding instance can also link to its
 * per-snapshot finding page. (`/app/$appSlug/issues/$issueId` is the deprecated `Issue` occurrence page.)
 */
export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/analysis/issues/$issueId")({
  loader: async ({ context, params: { issueId } }) => {
    await ensureAnalysisIssueDetailData(context.queryClient, issueId);
  },
  component: AnalysisIssuePage,
  errorComponent: AnalysisIssueErrorState,
});

function AnalysisIssuePage() {
  const { issueId } = Route.useParams();
  return <AnalysisIssueDetailPage issueId={issueId} />;
}
