import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

// The standalone preview-environment page has been folded into the PR pages: a PR's preview lives on
// its Preview tab, and the main-branch (PR #0) preview lives on the main-branch page. This route is
// kept only to redirect old/bookmarked `/preview/:environmentId` links to their new home.
export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/preview/$environmentId")({
  loader: async ({ context, params: { appSlug, environmentId } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();

    const summary = await ensureAPIQueryData(
      context.queryClient,
      trpc.deployments.previewSummaryById.queryOptions({ applicationId: app.id, environmentId }),
    );

    if (summary.prNumber > 0) {
      throw redirect({
        to: "/app/$appSlug/pull-requests/$prNumber/preview",
        params: { appSlug, prNumber: summary.prNumber },
      });
    }
    throw redirect({ to: "/app/$appSlug/pull-requests/main", params: { appSlug } });
  },
});
