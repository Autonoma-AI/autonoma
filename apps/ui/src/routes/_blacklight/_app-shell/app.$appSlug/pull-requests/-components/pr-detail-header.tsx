import { Badge, Button, Skeleton } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { formatRelativeTime } from "lib/format";
import type { RouterOutputs } from "lib/trpc";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { BranchPill } from "./branch-pill";
import { PRAuthorStack } from "./pr-author-stack";

type PullRequest = RouterOutputs["github"]["getPullRequest"];

export function PRDetailHeader({
  applicationId,
  prNumber,
  branchName,
  pr,
  prPending,
}: {
  applicationId: string;
  prNumber: number;
  branchName: string;
  pr: PullRequest | undefined;
  prPending: boolean;
}) {
  const title = pr?.title ?? branchName;

  return (
    <header className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-text-tertiary">
        <AppLink
          to="/app/$appSlug/pull-requests"
          aria-label="Back to pull requests"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-primary"
        >
          <ArrowLeftIcon size={12} />
        </AppLink>
        <GitPullRequestIcon size={14} />
        <span className="font-mono text-2xs uppercase tracking-widest">Pull request</span>
        <span className="font-mono text-2xs">#{prNumber}</span>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {prPending ? (
            <Skeleton className="h-7 w-96" />
          ) : (
            <h1 className="flex flex-wrap items-baseline gap-3 text-2xl font-medium tracking-tight text-text-primary">
              <span className="break-words">{title}</span>
              <span className="font-mono text-lg font-normal text-text-tertiary">#{prNumber}</span>
            </h1>
          )}
          <MetaRow
            applicationId={applicationId}
            prNumber={prNumber}
            branchName={branchName}
            pr={pr}
            prPending={prPending}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <AppLink to="/app/$appSlug/pull-requests/$prNumber/suite" params={{ prNumber }}>
            <Button variant="outline" size="sm">
              <ListChecksIcon size={14} />
              View active suite
            </Button>
          </AppLink>
          {pr?.url != null && (
            <a href={pr.url} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm">
                View on GitHub
                <ArrowSquareOutIcon size={12} />
              </Button>
            </a>
          )}
        </div>
      </div>
    </header>
  );
}

function MetaRow({
  applicationId,
  prNumber,
  branchName,
  pr,
  prPending,
}: {
  applicationId: string;
  prNumber: number;
  branchName: string;
  pr: PullRequest | undefined;
  prPending: boolean;
}) {
  if (prPending) return <Skeleton className="h-5 w-[420px]" />;

  const state = pr?.state ?? "open";
  const author = pr?.authorLogin;
  const baseRef = pr?.baseRef;
  const headRef = pr?.headRef ?? branchName;
  const commitsCount = pr?.commitsCount ?? 0;
  const createdAt = pr?.createdAt != null ? new Date(pr.createdAt) : undefined;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-text-secondary">
      <StateBadge state={state} />

      {author != null && (
        <div className="flex items-center gap-2">
          <PRAuthorStack applicationId={applicationId} prNumber={prNumber} primaryAuthor={author} />
          <span className="font-medium text-text-primary">{author}</span>
          <span className="text-text-tertiary">
            wants to merge {commitsCount} {commitsCount === 1 ? "commit" : "commits"} into
          </span>
        </div>
      )}

      {baseRef != null ? (
        <div className="flex items-center gap-2">
          <BranchPill name={baseRef} emphasize />
          <ArrowLeftIcon size={12} className="text-text-tertiary" />
          <BranchPill name={headRef} />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <BranchPill name={headRef} />
          <ArrowRightIcon size={12} className="text-text-tertiary" />
          <span className="text-text-tertiary">PR #{prNumber}</span>
        </div>
      )}

      {createdAt != null && <span className="text-text-tertiary">· created {formatRelativeTime(createdAt)}</span>}
    </div>
  );
}

function StateBadge({ state }: { state: "open" | "closed" | "merged" }) {
  if (state === "merged") {
    return (
      <Badge variant="outline" className="gap-1 border-primary-ink/40 bg-primary-ink/5 text-primary-ink">
        <GitPullRequestIcon size={12} />
        Merged
      </Badge>
    );
  }
  if (state === "closed") {
    return (
      <Badge variant="outline" className="gap-1 border-status-critical/40 bg-status-critical/5 text-status-critical">
        <GitPullRequestIcon size={12} />
        Closed
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="gap-1">
      <GitPullRequestIcon size={12} />
      Open
    </Badge>
  );
}
