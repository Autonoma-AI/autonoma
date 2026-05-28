import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/changes/",
)({
  component: ChangesEmptyState,
});

function ChangesEmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-5 py-12 text-text-tertiary">
      <ListChecksIcon size={28} />
      <p className="text-sm">Select a test to view its details</p>
    </div>
  );
}
