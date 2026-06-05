import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/",
)({
  component: () => null,
});
