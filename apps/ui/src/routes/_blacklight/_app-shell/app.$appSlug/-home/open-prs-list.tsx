import { Badge, EmptyState, Pagination, Skeleton } from "@autonoma/blacklight";
import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { Link } from "@tanstack/react-router";
import { PreviewLivenessBadge } from "components/preview-liveness-badge";
import { formatRelativeTime } from "lib/format";
import { type LatestPullRequest, useLatestPullRequests } from "lib/query/latest-prs.queries";
import {
  pickPreviewLiveness,
  type PreviewLivenessState,
  useApplicationPreviewLiveness,
} from "lib/query/preview-access.queries";
import { AppLink } from "../../-app-link";
import { CheckpointSummaryBadge } from "../pull-requests/-components/checkpoint-summary-badge";

export function OpenPrsList({ page, onPageChange }: { page: number; onPageChange: (page: number) => void }) {
  const prs = useLatestPullRequests(page);
  // One liveness poll covering every preview the app has (never wakes them).
  const { data: liveness } = useApplicationPreviewLiveness();

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2.5">
        <h2 className="text-sm font-semibold text-text-primary">Open pull requests</h2>
        <span className="font-mono text-[11px] text-text-secondary">· {prs.totalCount} · most recently updated</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col border border-border-dim bg-surface-base">
        <div className="flex shrink-0 items-center gap-3 border-b border-border-mid bg-surface-void px-4 py-2.5">
          <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
            {prs.totalCount} open
          </span>
          <span className="ml-auto font-mono text-[10px] text-text-secondary">health · branch · last activity</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {prs.items.length === 0 ? (
            <EmptyState
              className="border-0 bg-transparent"
              icon={<GitPullRequestIcon size={32} />}
              title="No open pull requests"
              description="Push a branch with an open PR to see it tracked here."
            />
          ) : (
            prs.items.map((pr) => <PrRow key={pr.id} pr={pr} liveness={liveness} />)
          )}
        </div>

        <Pagination page={prs.page} pageCount={prs.pageCount} onPageChange={onPageChange} />
      </div>
    </section>
  );
}

function PrRow({ pr, liveness }: { pr: LatestPullRequest; liveness?: Record<string, PreviewLivenessState> }) {
  const livenessState = pickPreviewLiveness(liveness, [pr.previewUrl]);
  return (
    <div className="relative flex items-center gap-3 border-t border-border-dim px-4 py-3 transition-colors first:border-t-0 hover:bg-surface-raised">
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber"
        params={{ prNumber: String(pr.prNumber) }}
        aria-label={`Pull request #${pr.prNumber}`}
        className="absolute inset-0"
      />

      <GitPullRequestIcon size={14} weight="fill" className="shrink-0 text-text-secondary" />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">{pr.title ?? pr.branchName}</span>
          <HealthBadge pr={pr} />
        </div>
        <div className="truncate font-mono text-[11px] text-text-secondary">
          #{pr.prNumber} · opened {formatRelativeTime(pr.createdAt)}
          {pr.authorLogin != null && ` by @${pr.authorLogin}`} ·{" "}
          <span className="text-text-secondary">{pr.branchName}</span> {"->"} {pr.baseBranchName}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3.5 font-mono text-[11px] text-text-secondary">
        {pr.commits != null && (
          <span>
            {pr.commits} {pr.commits === 1 ? "commit" : "commits"}
          </span>
        )}
        <span>
          {pr.testCount} {pr.testCount === 1 ? "test" : "tests"}
        </span>
        {pr.previewUrl != null && (
          <>
            <PreviewLivenessBadge state={livenessState} className="relative z-10 text-[9px]" />
            <Link
              to="/preview-waiting"
              search={{ to: pr.previewUrl }}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="relative z-10 inline-flex items-center gap-0.5 text-primary-ink hover:underline"
            >
              preview
              <ArrowUpRightIcon size={11} weight="bold" />
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

function HealthBadge({ pr }: { pr: LatestPullRequest }) {
  if (pr.summary == null) return undefined;
  // Healthy PRs render muted; only problems use red/amber.
  if (pr.summary.tone === "success") {
    return (
      <Badge
        variant="outline"
        className="border-border-mid font-mono text-[10px] uppercase tracking-wider text-text-secondary"
      >
        ● {pr.summary.label}
      </Badge>
    );
  }
  return <CheckpointSummaryBadge summary={pr.summary} />;
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
              <Skeleton className="size-3.5 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
