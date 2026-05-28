import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/",
)({
  loader: ({ params }) => {
    throw redirect({
      to: "/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/overview",
      params,
    });
  },
});
