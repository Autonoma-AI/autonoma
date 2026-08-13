import { prActivityLabel } from "./pr-activity-label";
import type { PullRequestRow } from "./pull-request-row";

export function PRNameCell({ title, branchName }: { title?: string; branchName: string }) {
  // Fall back to the branch name until the cached PR title is populated.
  if (title == null) {
    return <span className="block truncate text-sm text-text-primary">{branchName}</span>;
  }
  return <span className="block truncate text-sm font-medium text-text-primary">{title}</span>;
}

export function PRAuthorCell({ authorLogin }: { authorLogin?: string }) {
  if (authorLogin == null) {
    return <span className="text-sm text-text-secondary">-</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <img
        src={`https://github.com/${authorLogin}.png?size=40`}
        alt=""
        className="size-5 shrink-0 border border-border-dim bg-surface-raised object-cover"
      />
      <span className="min-w-0 truncate text-sm text-text-secondary">{authorLogin}</span>
    </span>
  );
}

export function PRActivityCell({ row }: { row: PullRequestRow }) {
  return <span className="whitespace-nowrap font-mono text-xs text-text-secondary">{prActivityLabel(row)}</span>;
}
