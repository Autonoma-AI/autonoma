import { Button, Popover, PopoverContent, PopoverTrigger, Skeleton } from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { formatDate, formatRelativeTime } from "lib/format";
import type { RouterOutputs } from "lib/trpc";
import { Suspense } from "react";
import { BranchPill } from "./branch-pill";
import { PRAuthorStack } from "./pr-author-stack";
import { type PRTab, PRTabs } from "./pr-tabs";

type PullRequest = RouterOutputs["github"]["getPullRequest"];

// The row below the top bar: the Overview/Preview tab switcher on the left (only rendered when a
// previewkit environment exists) and the PR's author/branch/details on the right - always visible
// regardless of whether tabs are present, pushed to the far edge via ml-auto rather than
// justify-between so it doesn't jump to the left when there are no tabs to share the row with.
export function PRMetaRow({
  applicationId,
  prNumber,
  branchName,
  targetBranchName,
  pr,
  prPending,
  active,
}: {
  applicationId: string;
  prNumber: number;
  branchName: string;
  targetBranchName: string;
  pr: PullRequest | undefined;
  prPending: boolean;
  active: PRTab;
}) {
  return (
    <div className="flex items-center gap-4 border-b border-border-dim bg-surface-void px-6 py-2">
      <Suspense fallback={<div className="h-8" />}>
        <PRTabs applicationId={applicationId} prNumber={prNumber} active={active} />
      </Suspense>
      <div className="ml-auto">
        <MetaDetails
          applicationId={applicationId}
          prNumber={prNumber}
          branchName={branchName}
          targetBranchName={targetBranchName}
          pr={pr}
          prPending={prPending}
        />
      </div>
    </div>
  );
}

function MetaDetails({
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
  if (prPending) return <Skeleton className="h-5 w-64" />;

  const author = pr?.authorLogin;
  const baseRef = pr?.baseRef;
  const headRef = pr?.headRef ?? branchName;
  const resolvedBaseRef = baseRef ?? targetBranchName;
  const commitsCount = pr?.commitsCount ?? 0;
  const createdAt = pr?.createdAt != null ? new Date(pr.createdAt) : undefined;
  const headSha = pr?.headSha;

  return (
    <div className="flex items-center gap-3 text-sm text-text-secondary">
      {author != null && (
        <div className="flex items-center gap-2">
          <PRAuthorStack applicationId={applicationId} prNumber={prNumber} primaryAuthor={author} />
          <span className="font-medium text-text-primary">@{author}</span>
        </div>
      )}

      <BranchPill name={headRef} emphasize />

      <Popover>
        <PopoverTrigger
          render={
            <Button variant="outline" size="xs" className="group gap-1 font-mono text-3xs uppercase tracking-wider" />
          }
        >
          Details
          <CaretDownIcon size={10} className="transition-transform group-data-[popup-open]:rotate-180" />
        </PopoverTrigger>
        <PopoverContent align="end">
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 whitespace-nowrap">
            <dt className="text-3xs uppercase tracking-wide text-text-tertiary">Source</dt>
            <dd className="text-xs text-text-primary">{headRef}</dd>

            <dt className="text-3xs uppercase tracking-wide text-text-tertiary">Base</dt>
            <dd className="text-xs text-text-primary">{resolvedBaseRef}</dd>

            <dt className="text-3xs uppercase tracking-wide text-text-tertiary">Commits</dt>
            <dd className="text-xs text-text-primary">
              {commitsCount} {commitsCount === 1 ? "commit" : "commits"}
              {headSha != null && ` · ${headSha.slice(0, 7)}`}
            </dd>

            <dt className="text-3xs uppercase tracking-wide text-text-tertiary">Created</dt>
            <dd className="text-xs text-text-primary">
              {createdAt != null ? `${formatRelativeTime(createdAt)} · ${formatDate(createdAt)}` : "-"}
            </dd>
          </dl>
        </PopoverContent>
      </Popover>
    </div>
  );
}
