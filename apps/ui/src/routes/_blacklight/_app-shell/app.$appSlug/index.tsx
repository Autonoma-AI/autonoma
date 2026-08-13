import { createFileRoute, redirect } from "@tanstack/react-router";
import { toPageParam } from "lib/page-param";

/**
 * The application root is the pull request list.
 *
 * It used to be a second surface over the same `branches.list` query - a different table, a different status
 * vocabulary, and no way to tell which of the two was authoritative. The list absorbed it, so this route exists
 * to keep every link that pointed at the app root working: the app selector, the finish-setup exits, and the
 * generation progress screen all send people here.
 *
 * `?prs` was the old pager, and the old list was hard-filtered to open pull requests, so it maps onto the open
 * tab's page. The redirect replaces rather than pushes, so the back button does not bounce off it.
 */
export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/")({
  validateSearch: (search: Record<string, unknown>): { prs?: number } => {
    const page = toPageParam(search.prs);
    return page > 1 ? { prs: page } : {};
  },
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/app/$appSlug/pull-requests",
      params,
      search: { state: "open", page: search.prs },
      replace: true,
    });
  },
});
