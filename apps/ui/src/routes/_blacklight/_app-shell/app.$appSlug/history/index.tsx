import { Badge, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { createFileRoute } from "@tanstack/react-router";
import { formatDate } from "lib/format";
import { ensureBranchData, ensureSnapshotHistoryData, useSnapshotHistory } from "lib/query/branches.queries";
import { Suspense } from "react";
import { useMainBranch } from "../-use-main-branch";
import { SettingsTabNav } from "../settings/-settings-tab-nav";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/history/")({
  loader: async ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) return;
    const branch = await ensureBranchData(context.queryClient, app.id, app.mainBranch.name);
    await ensureSnapshotHistoryData(context.queryClient, branch.id);
  },
  component: SnapshotHistoryPage,
});

function statusBadgeVariant(status: string): "success" | "critical" | "outline" {
  switch (status) {
    case "active":
      return "success";
    case "failed":
      return "critical";
    default:
      return "outline";
  }
}

function TableSkeleton() {
  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <ClockCounterClockwiseIcon size={14} className="text-text-tertiary" />
        <PanelTitle>Snapshots</PanelTitle>
      </PanelHeader>
      <PanelBody className="p-4">
        <div className="flex flex-col gap-3">
          {["sk-1", "sk-2", "sk-3", "sk-4", "sk-5", "sk-6"].map((id) => (
            <Skeleton key={id} className="h-10 w-full" />
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}

function HistoryContent() {
  const branch = useMainBranch();
  const { data: snapshots } = useSnapshotHistory(branch.id);

  if (snapshots.length === 0) {
    return (
      <Panel>
        <PanelBody>
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-text-tertiary">
            <ClockCounterClockwiseIcon size={32} />
            <p className="text-sm">No snapshots yet</p>
          </div>
        </PanelBody>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <ClockCounterClockwiseIcon size={14} className="text-text-tertiary" />
        <PanelTitle>Snapshots</PanelTitle>
        <span className="ml-auto font-mono text-2xs text-text-tertiary">{snapshots.length} total</span>
      </PanelHeader>
      <PanelBody className="p-0">
        <ul>
          {snapshots.map((snapshot) => (
            <li
              key={snapshot.id}
              className="flex items-center gap-4 border-b border-border-dim px-4 py-3 last:border-b-0"
            >
              <Badge variant={statusBadgeVariant(snapshot.status)}>{snapshot.status}</Badge>
              <span className="text-sm text-text-secondary">{snapshot.source}</span>
              <span className="font-mono text-2xs text-text-tertiary">
                {snapshot._count.testCaseAssignments} {snapshot._count.testCaseAssignments === 1 ? "test" : "tests"}
              </span>
              <span className="ml-auto text-2xs text-text-tertiary">{formatDate(snapshot.createdAt)}</span>
            </li>
          ))}
        </ul>
      </PanelBody>
    </Panel>
  );
}

function SnapshotHistoryPage() {
  const { appSlug } = Route.useParams();

  return (
    <div className="flex flex-col gap-6">
      <SettingsTabNav activeTab="history" appSlug={appSlug} />
      <Suspense fallback={<TableSkeleton />}>
        <HistoryContent />
      </Suspense>
    </div>
  );
}
