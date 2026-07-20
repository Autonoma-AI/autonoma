import { Skeleton } from "@autonoma/blacklight";
import type { PrPipelineStatus } from "@autonoma/types";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { formatRelativeTime } from "lib/format";
import type { RouterOutputs } from "lib/trpc";
import type { ReactNode } from "react";
import { BranchPill } from "./branch-pill";
import { PRAuthorStack } from "./pr-author-stack";
import { PrStatusBadge } from "./pr-status-badge";

type PullRequest = RouterOutputs["github"]["getPullRequest"];

export function PRDetailHeader({
  applicationId,
  prNumber,
  branchName,
  cachedTitle,
  targetBranchName,
  pr,
  prPending,
  status,
  tabs,
}: {
  applicationId: string;
  prNumber: number;
  branchName: string;
  cachedTitle: string | undefined;
  targetBranchName: string;
  pr: PullRequest | undefined;
  prPending: boolean;
  status: PrPipelineStatus;
  tabs: ReactNode;
}) {
  // Prefer the live GitHub title, fall back to the cached PR title (same source as the PR list), and
  // only fall back to the branch name when neither is available.
  const title = pr?.title ?? cachedTitle ?? branchName;
  // Show the cached title immediately rather than a skeleton while the live PR fetch is in flight.
  const showTitleSkeleton = prPending && pr?.title == null && cachedTitle == null;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border-dim bg-surface-base px-6 py-3">
      <div className="flex items-center gap-3">
        <span className="shrink-0 font-mono text-2xs text-text-tertiary">#{prNumber}</span>
        {showTitleSkeleton ? (
          <Skeleton className="h-5 w-96" />
        ) : (
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" title={title}>
            {title}
          </h1>
        )}
        <PrStatusBadge status={status} />
        {tabs}
      </div>
      <MetaRow
        applicationId={applicationId}
        prNumber={prNumber}
        branchName={branchName}
        targetBranchName={targetBranchName}
        pr={pr}
        prPending={prPending}
      />
    </div>
  );
}

function MetaRow({
  applicationId,
  prNumber,
  branchName,
  targetBranchName,
  pr,
  prPending,
}: {
  applicationId: string;
  prNumber: number;
  branchName: string;
  targetBranchName: string;
  pr: PullRequest | undefined;
  prPending: boolean;
}) {
  if (prPending) return <Skeleton className="h-5 w-[420px]" />;

  const author = pr?.authorLogin;
  const baseRef = pr?.baseRef;
  const headRef = pr?.headRef ?? branchName;
  const resolvedBaseRef = baseRef ?? targetBranchName;
  const commitsCount = pr?.commitsCount ?? 0;
  const createdAt = pr?.createdAt != null ? new Date(pr.createdAt) : undefined;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-text-secondary">
      {author != null && (
        <div className="flex items-center gap-2">
          <PRAuthorStack applicationId={applicationId} prNumber={prNumber} primaryAuthor={author} />
          <span className="font-medium text-text-primary">@{author}</span>
          <span className="text-text-tertiary">
            {commitsCount} {commitsCount === 1 ? "commit" : "commits"}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <BranchPill name={headRef} />
        <ArrowRightIcon size={12} className="text-text-tertiary" />
        <BranchPill name={resolvedBaseRef} emphasize />
      </div>

      {createdAt != null && <span className="text-text-tertiary">· created {formatRelativeTime(createdAt)}</span>}
    </div>
  );
}
