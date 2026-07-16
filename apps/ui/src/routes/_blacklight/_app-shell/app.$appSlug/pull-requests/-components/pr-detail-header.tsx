import { Skeleton } from "@autonoma/blacklight";
import type { PrPipelineStatus } from "@autonoma/types";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { formatRelativeTime } from "lib/format";
import type { RouterOutputs } from "lib/trpc";
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
}: {
  applicationId: string;
  prNumber: number;
  branchName: string;
  cachedTitle: string | undefined;
  targetBranchName: string;
  pr: PullRequest | undefined;
  prPending: boolean;
  status: PrPipelineStatus;
}) {
  // Prefer the live GitHub title, fall back to the cached PR title (same source as the PR list), and
  // only fall back to the branch name when neither is available.
  const title = pr?.title ?? cachedTitle ?? branchName;
  // Show the cached title immediately rather than a skeleton while the live PR fetch is in flight.
  const showTitleSkeleton = prPending && pr?.title == null && cachedTitle == null;

  return (
    <header className="flex min-h-36 items-start justify-between gap-4 border-b border-border-dim bg-surface-base px-6 py-5">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
            PR <span className="text-text-primary">#{prNumber}</span>
          </span>
        </div>

        {showTitleSkeleton ? (
          <Skeleton className="h-7 w-96" />
        ) : (
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight text-text-primary">
            <span className="break-words">{title}</span>
          </h1>
        )}
        <MetaRow
          applicationId={applicationId}
          prNumber={prNumber}
          branchName={branchName}
          targetBranchName={targetBranchName}
          pr={pr}
          prPending={prPending}
        />
      </div>

      <div className="flex shrink-0 flex-col items-end gap-3">
        <PrStatusBadge status={status} />
      </div>
    </header>
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
