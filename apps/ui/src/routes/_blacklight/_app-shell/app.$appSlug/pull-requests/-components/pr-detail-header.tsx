import { Badge, Skeleton } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { formatRelativeTime } from "lib/format";
import type { RouterOutputs } from "lib/trpc";
import { BranchPill } from "./branch-pill";
import { PRAuthorStack } from "./pr-author-stack";

type PullRequest = RouterOutputs["github"]["getPullRequest"];
type PrHealth = "healthy" | "unhealthy" | "unknown";

export function PRDetailHeader({
  applicationId,
  prNumber,
  branchName,
  targetBranchName,
  pr,
  prPending,
  health,
  bugCount,
}: {
  applicationId: string;
  prNumber: number;
  branchName: string;
  targetBranchName: string;
  pr: PullRequest | undefined;
  prPending: boolean;
  health: PrHealth;
  bugCount: number;
}) {
  const title = pr?.title ?? branchName;

  return (
    <header className="border-b border-border-dim bg-surface-base px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
              PR <span className="text-text-primary">#{prNumber}</span>
            </span>
          </div>

          {prPending ? (
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

        <HealthBadge health={health} bugCount={bugCount} />
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

function HealthBadge({ health, bugCount }: { health: PrHealth; bugCount: number }) {
  if (health === "healthy") {
    return (
      <Badge variant="success" className="shrink-0 gap-1 font-mono uppercase tracking-wider">
        Healthy
      </Badge>
    );
  }
  if (health === "unhealthy") {
    return (
      <Badge
        variant="outline"
        className="shrink-0 gap-2 border-status-critical/60 bg-status-critical/10 font-mono uppercase tracking-wider text-status-critical"
      >
        Unhealthy
        <span className="text-text-tertiary">·</span>
        {bugCount} {bugCount === 1 ? "bug" : "bugs"}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="shrink-0 gap-1 font-mono uppercase tracking-wider text-text-tertiary">
      Unknown
    </Badge>
  );
}
