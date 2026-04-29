import { Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { FilesIcon } from "@phosphor-icons/react/Files";
import { GitCommitIcon } from "@phosphor-icons/react/GitCommit";
import { StackIcon } from "@phosphor-icons/react/Stack";
import { formatRelativeTime } from "lib/format";
import type { RouterOutputs } from "lib/trpc";

type PullRequest = RouterOutputs["github"]["getPullRequest"];

interface PRMetadataPanelProps {
  pr: PullRequest | undefined;
  prPending: boolean;
  snapshotCount: number;
}

export function PRMetadataPanel({ pr, prPending, snapshotCount }: PRMetadataPanelProps) {
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Metadata</PanelTitle>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-0 p-0">
        <Row icon={<GitCommitIcon size={12} />} label="Commits">
          {prPending ? <Skeleton className="h-4 w-8" /> : <MetaValue>{pr?.commitsCount ?? 0}</MetaValue>}
        </Row>
        <Row icon={<StackIcon size={12} />} label="Snapshots">
          <MetaValue>{snapshotCount}</MetaValue>
        </Row>
        <Row icon={<ClockIcon size={12} />} label="Created">
          {prPending ? (
            <Skeleton className="h-4 w-20" />
          ) : pr?.createdAt != null ? (
            <MetaValue>{formatRelativeTime(new Date(pr.createdAt))}</MetaValue>
          ) : (
            <MetaValue muted>-</MetaValue>
          )}
        </Row>
        <Row icon={<FilesIcon size={12} />} label="Updated" last>
          {prPending ? (
            <Skeleton className="h-4 w-20" />
          ) : pr?.updatedAt != null ? (
            <MetaValue>{formatRelativeTime(new Date(pr.updatedAt))}</MetaValue>
          ) : (
            <MetaValue muted>-</MetaValue>
          )}
        </Row>
      </PanelBody>
    </Panel>
  );
}

function Row({
  icon,
  label,
  last,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex items-center justify-between px-5 py-3 ${last === true ? "" : "border-b border-border-dim"}`}>
      <span className="flex items-center gap-2 font-mono text-2xs uppercase tracking-widest text-text-tertiary">
        {icon}
        {label}
      </span>
      <div>{children}</div>
    </div>
  );
}

function MetaValue({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span className={`font-mono text-xs ${muted === true ? "text-text-tertiary" : "text-text-primary"}`}>
      {children}
    </span>
  );
}
