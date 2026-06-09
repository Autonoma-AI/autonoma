import { Badge, EmptyState } from "@autonoma/blacklight";
import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { formatRelativeTime } from "lib/format";
import { type LatestPullRequest, useLatestPullRequests } from "lib/query/latest-prs.queries";
import { AppLink } from "../../-app-link";

export function OpenPrsList() {
  const prs = useLatestPullRequests();

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2.5">
        <h2 className="text-sm font-semibold text-text-primary">Open pull requests</h2>
        <span className="font-mono text-[11px] text-text-tertiary">· {prs.length} · sorted by recency</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col border border-border-dim bg-surface-base">
        <div className="flex shrink-0 items-center gap-3 border-b border-border-mid bg-surface-void px-4 py-2.5">
          <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
            {prs.length} open
          </span>
          <span className="ml-auto font-mono text-[10px] text-text-tertiary">health · branch · last activity</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {prs.length === 0 ? (
            <EmptyState
              className="border-0 bg-transparent"
              icon={<GitPullRequestIcon size={32} />}
              title="No open pull requests"
              description="Push a branch with an open PR to see it tracked here."
            />
          ) : (
            prs.map((pr) => <PrRow key={pr.id} pr={pr} />)
          )}
        </div>
      </div>
    </section>
  );
}

function PrRow({ pr }: { pr: LatestPullRequest }) {
  return (
    <div className="relative flex items-center gap-3 border-t border-border-dim px-4 py-3 transition-colors first:border-t-0 hover:bg-surface-raised">
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber"
        params={{ prNumber: String(pr.prNumber) }}
        aria-label={`Pull request #${pr.prNumber}`}
        className="absolute inset-0"
      />

      <GitPullRequestIcon size={14} weight="fill" className="shrink-0 text-text-tertiary" />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">{pr.title ?? pr.branchName}</span>
          <HealthBadge pr={pr} />
        </div>
        <div className="truncate font-mono text-[11px] text-text-tertiary">
          #{pr.prNumber} · opened {formatRelativeTime(pr.createdAt)}
          {pr.authorLogin != null && ` by @${pr.authorLogin}`} ·{" "}
          <span className="text-text-secondary">{pr.branchName}</span> {"->"} {pr.baseBranchName}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3.5 font-mono text-[11px] text-text-tertiary">
        {pr.commits != null && (
          <span>
            {pr.commits} {pr.commits === 1 ? "commit" : "commits"}
          </span>
        )}
        <span>
          {pr.testCount} {pr.testCount === 1 ? "test" : "tests"}
        </span>
        {pr.previewUrl != null && (
          <a
            href={pr.previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="relative z-10 inline-flex items-center gap-0.5 text-primary-ink hover:underline"
          >
            preview
            <ArrowUpRightIcon size={11} weight="bold" />
          </a>
        )}
      </div>
    </div>
  );
}

function HealthBadge({ pr }: { pr: LatestPullRequest }) {
  if (pr.bugCount != null && pr.bugCount > 0) {
    return (
      <Badge variant="status-failed">
        ● {pr.bugCount} {pr.bugCount === 1 ? "bug" : "bugs"}
      </Badge>
    );
  }
  if (pr.health === "critical") return <Badge variant="status-failed">● critical</Badge>;
  if (pr.health === "running") return <Badge variant="status-running">● building</Badge>;
  if (pr.health === "healthy") {
    // Muted on purpose: a healthy PR should recede so only problems (red/amber) draw the eye.
    return (
      <Badge
        variant="outline"
        className="border-border-mid font-mono text-[10px] uppercase tracking-wider text-text-tertiary"
      >
        ● passing
      </Badge>
    );
  }
  return undefined;
}

export function OpenPrsListSkeleton() {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2.5">
        <h2 className="text-sm font-semibold text-text-primary">Open pull requests</h2>
      </div>
      <div className="flex min-h-0 flex-1 flex-col border border-border-dim bg-surface-base">
        <div className="flex shrink-0 items-center gap-3 border-b border-border-mid bg-surface-void px-4 py-2.5">
          <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
            open
          </span>
        </div>
        <div className="flex-1">
          {["sk-1", "sk-2", "sk-3", "sk-4", "sk-5"].map((id) => (
            <div key={id} className="flex items-center gap-3 border-t border-border-dim px-4 py-3 first:border-t-0">
              <div className="size-3.5 shrink-0 animate-pulse rounded-full bg-surface-raised" />
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="h-3.5 w-2/5 animate-pulse bg-surface-raised" />
                <div className="h-3 w-3/5 animate-pulse bg-surface-raised" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
