import { Badge, cn, EmptyState, Skeleton } from "@autonoma/blacklight";
import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { formatRelativeTime } from "lib/format";
import {
  INVESTIGATION_TONE_CLASS,
  type InvestigationPresence,
  investigationEntryLabel,
  investigationEntryTone,
  useInvestigationReportsBySnapshot,
} from "lib/query/branches.queries";
import { type LatestPullRequest, useLatestPullRequests } from "lib/query/latest-prs.queries";
import { AppLink } from "../../-app-link";
import { CheckpointSummaryBadge } from "../pull-requests/-components/checkpoint-summary-badge";

export function OpenPrsList() {
  const prs = useLatestPullRequests();
  // Internal-only (@autonoma.app); the hook is disabled for everyone else, so no entry point renders.
  const investigation = useInvestigationReportsBySnapshot(
    prs.map((pr) => pr.snapshotId).filter((id): id is string => id != null),
  );

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
            prs.map((pr) => (
              <PrRow
                key={pr.id}
                pr={pr}
                investigation={pr.snapshotId != null ? investigation.bySnapshot.get(pr.snapshotId) : undefined}
                investigationLoading={investigation.isLoading}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function PrRow({
  pr,
  investigation,
  investigationLoading,
}: {
  pr: LatestPullRequest;
  investigation?: InvestigationPresence;
  investigationLoading: boolean;
}) {
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
        {investigation != null && pr.snapshotId != null && (
          <InvestigationEntry prNumber={pr.prNumber} snapshotId={pr.snapshotId} investigation={investigation} />
        )}
        {investigation == null && investigationLoading && <Skeleton className="h-3 w-24" />}
      </div>
    </div>
  );
}

/**
 * The internal-only entry point onto the shadow investigation report, surfaced right on the PR row so it is not
 * buried inside the checkpoint page. Nested inside the row's full-bleed link, so it needs its own z-layer +
 * stopPropagation to win the click. Colored by severity (bug/warning/neutral); shows the bug count when there is
 * one, or a "running" hint while in flight.
 */
function InvestigationEntry({
  prNumber,
  snapshotId,
  investigation,
}: {
  prNumber: number;
  snapshotId: string;
  investigation: InvestigationPresence;
}) {
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/investigation"
      params={{ prNumber: String(prNumber), snapshotId }}
      onClick={(e) => e.stopPropagation()}
      aria-label={`Investigation report for PR #${prNumber}`}
      className={cn(
        "relative z-10 inline-flex items-center gap-1 hover:underline",
        INVESTIGATION_TONE_CLASS[investigationEntryTone(investigation)],
      )}
    >
      <MagnifyingGlassIcon size={11} />
      investigation
      <span>· {investigationEntryLabel(investigation)}</span>
    </AppLink>
  );
}

function HealthBadge({ pr }: { pr: LatestPullRequest }) {
  if (pr.summary == null) return undefined;
  // Healthy PRs render muted; only problems use red/amber.
  if (pr.summary.tone === "success") {
    return (
      <Badge
        variant="outline"
        className="border-border-mid font-mono text-[10px] uppercase tracking-wider text-text-tertiary"
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
