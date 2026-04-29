import { Badge, Skeleton } from "@autonoma/blacklight";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { formatRelativeTime } from "lib/format";
import { usePullRequestFromGitHub } from "lib/query/github.queries";

export function PRNameCell({
  applicationId,
  prNumber,
  branchName,
}: {
  applicationId: string;
  prNumber: number;
  branchName: string;
}) {
  const { data, isPending, isError } = usePullRequestFromGitHub(applicationId, prNumber);

  if (isPending) return <Skeleton className="h-4 w-64" />;
  if (isError || data == null) {
    return <span className="truncate text-sm text-text-primary">{branchName}</span>;
  }
  return <span className="truncate text-sm font-medium text-text-primary">{data.title}</span>;
}

export function PRAuthorCell({ applicationId, prNumber }: { applicationId: string; prNumber: number }) {
  const { data, isPending, isError } = usePullRequestFromGitHub(applicationId, prNumber);

  if (isPending) return <Skeleton className="h-4 w-24" />;
  if (isError || data?.authorLogin == null) {
    return <span className="text-sm text-text-tertiary">-</span>;
  }
  return (
    <span className="inline-flex items-center gap-2">
      <img
        src={`https://github.com/${data.authorLogin}.png?size=40`}
        alt=""
        className="size-5 shrink-0 border border-border-dim bg-surface-raised object-cover"
      />
      <span className="truncate text-sm text-text-secondary">{data.authorLogin}</span>
    </span>
  );
}

export function PRStateCell({ applicationId, prNumber }: { applicationId: string; prNumber: number }) {
  const { data, isPending, isError } = usePullRequestFromGitHub(applicationId, prNumber);

  if (isPending) return <Skeleton className="h-5 w-16" />;
  if (isError || data == null) {
    return (
      <Badge variant="success" className="gap-1">
        <GitPullRequestIcon size={10} />
        Open
      </Badge>
    );
  }
  if (data.state === "merged") {
    return (
      <Badge variant="outline" className="gap-1 border-primary-ink/40 bg-primary-ink/5 text-primary-ink">
        <GitPullRequestIcon size={10} />
        Merged
      </Badge>
    );
  }
  if (data.state === "closed") {
    return (
      <Badge variant="outline" className="gap-1 border-status-critical/40 bg-status-critical/5 text-status-critical">
        <GitPullRequestIcon size={10} />
        Closed
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="gap-1">
      <GitPullRequestIcon size={10} />
      Open
    </Badge>
  );
}

export function PRUpdatedCell({ applicationId, prNumber }: { applicationId: string; prNumber: number }) {
  const { data, isPending, isError } = usePullRequestFromGitHub(applicationId, prNumber);

  if (isPending) return <Skeleton className="h-4 w-16" />;
  if (isError || data?.updatedAt == null) return <span className="text-sm text-text-tertiary">-</span>;
  return <span className="font-mono text-xs text-text-secondary">{formatRelativeTime(new Date(data.updatedAt))}</span>;
}
