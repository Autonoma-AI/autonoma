import { Badge, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { ShaRange } from "components/snapshot/sha-range";
import { formatDate } from "lib/format";
import { useSnapshotHistory } from "lib/query/branches.queries";
import { useCommitFromGitHub } from "lib/query/github.queries";
import { Suspense } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

interface SnapshotListProps {
  branchId: string;
  applicationId: string;
  prNumber: number;
}

export function SnapshotList({ branchId, applicationId, prNumber }: SnapshotListProps) {
  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <ClockCounterClockwiseIcon size={14} className="text-text-tertiary" />
        <PanelTitle>Snapshots</PanelTitle>
      </PanelHeader>
      <PanelBody className="p-0">
        <Suspense fallback={<SnapshotListSkeleton />}>
          <SnapshotListContent branchId={branchId} applicationId={applicationId} prNumber={prNumber} />
        </Suspense>
      </PanelBody>
    </Panel>
  );
}

export function SnapshotListSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4">
      {["sk-1", "sk-2", "sk-3"].map((id) => (
        <Skeleton key={id} className="h-16 w-full" />
      ))}
    </div>
  );
}

function SnapshotListContent({
  branchId,
  applicationId,
  prNumber,
}: {
  branchId: string;
  applicationId: string;
  prNumber: number;
}) {
  const { data: snapshots } = useSnapshotHistory(branchId);

  if (snapshots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-text-tertiary">
        <ClockCounterClockwiseIcon size={32} />
        <p className="text-sm">No snapshots yet</p>
      </div>
    );
  }

  return (
    <ul>
      {snapshots.map((snapshot) => (
        <SnapshotCard key={snapshot.id} snapshot={snapshot} applicationId={applicationId} prNumber={prNumber} />
      ))}
    </ul>
  );
}

interface SnapshotCardProps {
  snapshot: {
    id: string;
    status: string;
    source: string;
    headSha: string | null;
    baseSha: string | null;
    createdAt: Date;
    changeSummary: { added: number; removed: number; updated: number };
  };
  applicationId: string;
  prNumber: number;
}

function SnapshotCard({ snapshot, applicationId, prNumber }: SnapshotCardProps) {
  return (
    <li className="border-b border-border-dim last:border-b-0">
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
        params={{ prNumber, snapshotId: snapshot.id }}
        className="flex flex-col gap-3 px-4 py-3 transition-colors hover:bg-surface-base"
      >
        <div className="flex items-center gap-3">
          <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
          <Badge variant={statusBadgeVariant(snapshot.status)}>{snapshot.status}</Badge>
          <span className="ml-auto text-2xs text-text-tertiary">{formatDate(snapshot.createdAt)}</span>
        </div>

        <CommitMessageLine applicationId={applicationId} sha={snapshot.headSha ?? undefined} />

        <ChangeSummaryChips summary={snapshot.changeSummary} />
      </AppLink>
    </li>
  );
}

function CommitMessageLine({ applicationId, sha }: { applicationId: string; sha: string | undefined }) {
  const { data, isPending, isError } = useCommitFromGitHub(applicationId, sha);

  if (sha == null) return <span className="text-sm text-text-tertiary">-</span>;
  if (isPending) return <Skeleton className="h-4 w-72" />;
  if (isError || data == null) return <span className="text-sm text-text-tertiary">-</span>;

  const firstLine = data.message.split("\n")[0] ?? "";
  return <span className="truncate text-sm text-text-secondary">{firstLine}</span>;
}

function ChangeSummaryChips({ summary }: { summary: { added: number; removed: number; updated: number } }) {
  const chips: Array<{ key: string; label: string; className: string }> = [];
  if (summary.added > 0) {
    chips.push({ key: "added", label: `+${summary.added} added`, className: "text-status-success" });
  }
  if (summary.updated > 0) {
    chips.push({ key: "updated", label: `~${summary.updated} updated`, className: "text-status-warn" });
  }
  if (summary.removed > 0) {
    chips.push({ key: "removed", label: `-${summary.removed} removed`, className: "text-status-critical" });
  }

  if (chips.length === 0) {
    return <span className="font-mono text-2xs text-text-tertiary">no changes</span>;
  }

  return (
    <div className="flex items-center gap-3 font-mono text-2xs">
      {chips.map((chip) => (
        <span key={chip.key} className={chip.className}>
          {chip.label}
        </span>
      ))}
    </div>
  );
}

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
