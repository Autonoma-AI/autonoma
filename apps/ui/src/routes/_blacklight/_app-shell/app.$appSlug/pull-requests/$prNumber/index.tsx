import { Badge, Button, Panel, PanelBody, Skeleton, StatusDot, cn } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ShaRange } from "components/snapshot/sha-range";
import { formatRelativeTime } from "lib/format";
import { ensureBranchByPrData, useBranchByPr, useSnapshotDetail, useSnapshotHistory } from "lib/query/branches.queries";
import { useBugsListByPr } from "lib/query/bugs.queries";
import { ensurePreviewEnvironmentSummaryData } from "lib/query/deployments.queries";
import {
  useApplicationRepositoryFromGitHub,
  useCommitFromGitHub,
  usePullRequestFromGitHub,
} from "lib/query/github.queries";
import type { RouterOutputs } from "lib/trpc";
import { Suspense, useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { CheckpointTestsRun } from "../-components/checkpoint-tests-run";
import { PRDetailHeader } from "../-components/pr-detail-header";
import { PreviewEnvironmentSection } from "../-components/preview-environment-section";

type Snapshot = RouterOutputs["branches"]["snapshotHistory"][number];
type SnapshotDetail = RouterOutputs["branches"]["snapshotDetail"];
type Bug = RouterOutputs["bugs"]["listByPr"][number];
type PullRequest = RouterOutputs["github"]["getPullRequest"];
type Repository = RouterOutputs["github"]["getApplicationRepository"];

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/")({
  loader: async ({ context, params: { appSlug, prNumber } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    await ensureBranchByPrData(context.queryClient, app.id, prNumber);
    void ensurePreviewEnvironmentSummaryData(context.queryClient, app.id, prNumber);
  },
  component: PullRequestDetailPage,
});

function PullRequestDetailPage() {
  const { prNumber } = Route.useParams();

  return (
    <div className="-m-6 flex min-h-full flex-col">
      <Suspense fallback={<PageSkeleton />}>
        <PullRequestDetailContent prNumber={prNumber} />
      </Suspense>
    </div>
  );
}

function PullRequestDetailContent({ prNumber }: { prNumber: number }) {
  const app = useCurrentApplication();
  const { data: branch } = useBranchByPr(app.id, prNumber);
  const { data: snapshots } = useSnapshotHistory(branch.id);
  const pr = usePullRequestFromGitHub(app.id, prNumber);
  const repository = useApplicationRepositoryFromGitHub(app.id);
  const prUrl = pr.data?.url ?? buildPullRequestUrl(repository.data, prNumber);
  const orderedSnapshots = [...snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const latestSnapshot = orderedSnapshots[0];

  if (latestSnapshot == null) {
    return (
      <>
        <PRTopBar appName={app.name} architecture={app.architecture} prNumber={prNumber} prUrl={prUrl} />
        <PRDetailHeader
          applicationId={app.id}
          prNumber={prNumber}
          branchName={branch.name}
          targetBranchName={pr.data?.baseRef ?? app.mainBranch.name}
          pr={pr.data ?? undefined}
          prPending={pr.isPending}
          health="unknown"
          bugCount={0}
        />
        <div className="p-6">
          <NoSnapshotsPanel />
        </div>
      </>
    );
  }

  return (
    <PullRequestDetailWithCheckpoint
      appName={app.name}
      appArchitecture={app.architecture}
      appMainBranchName={app.mainBranch.name}
      applicationId={app.id}
      branchId={branch.id}
      branchName={branch.name}
      prNumber={prNumber}
      pr={pr.data ?? undefined}
      prPending={pr.isPending}
      prUrl={prUrl}
      snapshots={orderedSnapshots}
      latestSnapshot={latestSnapshot}
    />
  );
}

function PullRequestDetailWithCheckpoint({
  appName,
  appArchitecture,
  appMainBranchName,
  applicationId,
  branchId,
  branchName,
  prNumber,
  pr,
  prPending,
  prUrl,
  snapshots,
  latestSnapshot,
}: {
  appName: string;
  appArchitecture: string;
  appMainBranchName: string;
  applicationId: string;
  branchId: string;
  branchName: string;
  prNumber: number;
  pr: PullRequest | undefined;
  prPending: boolean;
  prUrl: string | undefined;
  snapshots: Snapshot[];
  latestSnapshot: Snapshot;
}) {
  const { data: detail } = useSnapshotDetail(latestSnapshot.id);
  const { data: bugs } = useBugsListByPr(applicationId, branchId, "open", latestSnapshot.id);
  const health = detail.health === "healthy" && bugs.length === 0 ? "healthy" : "unhealthy";

  return (
    <>
      <PRTopBar appName={appName} architecture={appArchitecture} prNumber={prNumber} prUrl={prUrl} />
      <PRDetailHeader
        applicationId={applicationId}
        prNumber={prNumber}
        branchName={branchName}
        targetBranchName={pr?.baseRef ?? appMainBranchName}
        pr={pr}
        prPending={prPending}
        health={health}
        bugCount={bugs.length}
      />

      <div className="flex flex-col gap-5 p-6">
        <Suspense fallback={<PreviewSkeleton />}>
          <PreviewEnvironmentSection applicationId={applicationId} prNumber={prNumber} />
        </Suspense>

        <CheckpointsSection
          applicationId={applicationId}
          prNumber={prNumber}
          snapshots={snapshots}
          latestSnapshot={latestSnapshot}
          detail={detail}
          bugs={bugs}
        />
      </div>
    </>
  );
}

function PRTopBar({
  appName,
  architecture,
  prNumber,
  prUrl,
}: {
  appName: string;
  architecture: string;
  prNumber: number;
  prUrl: string | undefined;
}) {
  const appInitial = appName.trim().charAt(0).toUpperCase() || "A";

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border-dim bg-surface-void px-5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex size-5 shrink-0 items-center justify-center bg-primary font-mono text-3xs font-bold text-primary-foreground">
          {appInitial}
        </span>
        <span className="truncate text-xs font-medium text-text-secondary">
          {appName} / {architecture.toLowerCase()}
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-2 font-mono text-2xs text-text-secondary">
        <span className="text-text-tertiary">/</span>
        <AppLink to="/app/$appSlug/pull-requests" className="transition-colors hover:text-text-primary">
          Pull requests
        </AppLink>
        <span className="text-text-tertiary">/</span>
        <span className="text-text-primary">#{prNumber}</span>
      </div>

      {prUrl != null && (
        <a href={prUrl} target="_blank" rel="noopener noreferrer" className="ml-auto">
          <Button variant="outline" size="sm">
            <GitPullRequestIcon size={14} />
            Open in GitHub
            <ArrowSquareOutIcon size={12} />
          </Button>
        </a>
      )}
    </div>
  );
}

function buildPullRequestUrl(repository: Repository | undefined, prNumber: number) {
  if (repository == null) return undefined;
  return `https://github.com/${repository.fullName}/pull/${prNumber}`;
}

function CheckpointsSection({
  applicationId,
  prNumber,
  snapshots,
  latestSnapshot,
  detail,
  bugs,
}: {
  applicationId: string;
  prNumber: number;
  snapshots: Snapshot[];
  latestSnapshot: Snapshot;
  detail: SnapshotDetail;
  bugs: Bug[];
}) {
  const [showOlder, setShowOlder] = useState(false);
  const earlierSnapshots = snapshots.filter((snapshot) => snapshot.id !== latestSnapshot.id);
  const visibleEarlier = showOlder ? earlierSnapshots : earlierSnapshots.slice(0, 1);
  const hiddenCount = earlierSnapshots.length - visibleEarlier.length;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Checkpoints in this PR</h2>
        <span className="font-mono text-2xs text-text-tertiary">
          · {snapshots.length} {snapshots.length === 1 ? "checkpoint" : "checkpoints"} · sorted newest
        </span>
      </div>

      <LatestCheckpointCard
        applicationId={applicationId}
        prNumber={prNumber}
        snapshot={latestSnapshot}
        detail={detail}
        bugs={bugs}
      />

      {earlierSnapshots.length > 0 && (
        <div className="border border-border-dim bg-surface-base">
          {visibleEarlier.map((snapshot) => (
            <Suspense key={snapshot.id} fallback={<CompactCheckpointRowSkeleton snapshot={snapshot} />}>
              <CompactCheckpointRow applicationId={applicationId} prNumber={prNumber} snapshot={snapshot} />
            </Suspense>
          ))}

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowOlder(true)}
              className="flex w-full items-center gap-2 border-t border-dashed border-border-mid px-4 py-2.5 text-left font-mono text-2xs text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
            >
              <CaretDownIcon size={12} />
              View {hiddenCount} earlier {hiddenCount === 1 ? "checkpoint" : "checkpoints"}
              <span className="text-text-tertiary">· older analysis</span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function LatestCheckpointCard({
  applicationId,
  prNumber,
  snapshot,
  detail,
  bugs,
}: {
  applicationId: string;
  prNumber: number;
  snapshot: Snapshot;
  detail: SnapshotDetail;
  bugs: Bug[];
}) {
  const { data: commit } = useCommitFromGitHub(applicationId, snapshot.headSha ?? undefined);
  const commitMessage = commit?.message.split("\n")[0] ?? checkpointFallback(snapshot);
  const visibleBugs = bugs.slice(0, 3);

  return (
    <div className="border border-border-dim bg-surface-base">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-dim px-5 py-3">
        <Badge
          variant="outline"
          className="gap-1 border-primary-ink bg-primary-ink/10 font-mono uppercase tracking-wider text-primary-ink"
        >
          <StatusDot status="success" />
          Latest
        </Badge>
        <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{commitMessage}</span>
        <div className="flex items-center gap-3 font-mono text-2xs text-text-tertiary">
          <span>{detail.healthCounts.totalTests} tests</span>
          <span>·</span>
          <span>{formatRelativeTime(snapshot.createdAt)}</span>
        </div>
      </div>

      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="grid border border-border-dim bg-surface-base md:grid-cols-3">
          <CheckpointStat label="Passing" value={detail.healthCounts.passing} tone="success" />
          <CheckpointStat label="Failed" value={detail.healthCounts.failing} tone="critical" />
          <CheckpointStat label="Bugs found" value={bugs.length} tone={bugs.length > 0 ? "critical" : "neutral"} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">
            {visibleBugs.length === 0 ? "Tests run" : "Bugs found in this checkpoint"}
          </span>
          <AppLink
            to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
            params={{ prNumber, snapshotId: snapshot.id }}
            className="ml-auto"
          >
            <Button variant="default" size="sm">
              Open extended summary
              <ArrowRightIcon size={14} />
            </Button>
          </AppLink>
        </div>

        {visibleBugs.length > 0 && (
          <div className="flex flex-col gap-2">
            {visibleBugs.map((bug) => (
              <CheckpointBugRow key={bug.id} bug={bug} />
            ))}
          </div>
        )}

        {visibleBugs.length > 0 && (
          <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">
            Tests run
          </span>
        )}
        <CheckpointTestsRun
          executedTests={detail.executedTests}
          totalTests={detail.healthCounts.totalTests}
          maxRows={6}
        />
      </div>
    </div>
  );
}

function CheckpointStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "critical" | "neutral";
}) {
  return (
    <div className="border-b border-border-dim p-4 last:border-b-0 md:border-r md:border-b-0 md:last:border-r-0">
      <span className="font-mono text-3xs font-semibold uppercase tracking-widest text-text-tertiary">{label}</span>
      <div
        className={cn(
          "mt-1 font-mono text-3xl font-bold tabular-nums",
          tone === "success" && "text-status-success",
          tone === "critical" && "text-status-critical",
          tone === "neutral" && "text-text-primary",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function CheckpointBugRow({ bug }: { bug: Bug }) {
  const primaryTestCase = bug.testCases[0];
  const testLabel = primaryTestCase?.slug ?? primaryTestCase?.name ?? "No linked test case";

  return (
    <AppLink
      to="/app/$appSlug/bugs/$bugId"
      params={{ bugId: bug.id }}
      className="flex items-center gap-3 border border-border-dim bg-surface-void p-2 transition-colors hover:border-border-mid hover:bg-surface-raised"
    >
      {bug.thumbnail?.url != null ? (
        <img
          src={bug.thumbnail.url}
          alt=""
          className="h-14 w-24 shrink-0 border border-border-mid object-cover"
          loading="lazy"
        />
      ) : (
        <div className="h-14 w-24 shrink-0 border border-border-mid bg-[repeating-linear-gradient(45deg,var(--surface-base),var(--surface-base)_6px,transparent_6px,transparent_12px)]" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-text-primary">{bug.title}</span>
          <Badge variant={SEVERITY_BADGE[bug.severity] ?? "secondary"}>{bug.severity}</Badge>
        </div>
        <div className="mt-1 truncate font-mono text-2xs text-text-tertiary">
          {testLabel} · x{bug.occurrences} {bug.occurrences === 1 ? "occurrence" : "occurrences"}
        </div>
      </div>
    </AppLink>
  );
}

function CompactCheckpointRow({
  applicationId,
  prNumber,
  snapshot,
}: {
  applicationId: string;
  prNumber: number;
  snapshot: Snapshot;
}) {
  const { data: commit } = useCommitFromGitHub(applicationId, snapshot.headSha ?? undefined);
  const { data: detail } = useSnapshotDetail(snapshot.id);
  const { data: bugs } = useBugsListByPr(applicationId, detail.snapshot.branch.id, "open", snapshot.id);
  const commitMessage = commit?.message.split("\n")[0] ?? checkpointFallback(snapshot);
  const isHealthy = detail.health === "healthy" && bugs.length === 0;

  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
      params={{ prNumber, snapshotId: snapshot.id }}
      className="flex items-center gap-3 border-b border-border-dim px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-raised"
    >
      {isHealthy ? (
        <Badge variant="success" className="font-mono uppercase tracking-wider">
          Healthy
        </Badge>
      ) : (
        <Badge
          variant="outline"
          className="border-status-critical/60 bg-status-critical/10 font-mono uppercase tracking-wider text-status-critical"
        >
          {bugs.length} {bugs.length === 1 ? "bug" : "bugs"}
        </Badge>
      )}
      <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{commitMessage}</span>
      <span className="hidden font-mono text-2xs text-text-tertiary md:inline">
        {detail.healthCounts.totalTests} tests · {formatRelativeTime(snapshot.createdAt)}
      </span>
    </AppLink>
  );
}

function CompactCheckpointRowSkeleton({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="flex items-center gap-3 border-b border-border-dim px-4 py-3 last:border-b-0">
      <Skeleton className="h-6 w-20" />
      <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
      <Skeleton className="h-4 min-w-0 flex-1" />
      <Skeleton className="hidden h-3 w-28 md:block" />
    </div>
  );
}

function checkpointFallback(snapshot: Snapshot) {
  return `Checkpoint ${shortSha(snapshot.baseSha)} -> ${shortSha(snapshot.headSha)}`;
}

function shortSha(sha: string | null | undefined) {
  return sha?.slice(0, 7) ?? "unknown";
}

function NoSnapshotsPanel() {
  return (
    <Panel>
      <PanelBody>
        <div className="flex flex-col items-center justify-center gap-3 py-14 text-center text-text-tertiary">
          <GitPullRequestIcon size={28} />
          <p className="text-sm">No checkpoints yet for this pull request</p>
        </div>
      </PanelBody>
    </Panel>
  );
}

function PreviewSkeleton() {
  return <Skeleton className="h-16 w-full" />;
}

function PageSkeleton() {
  return (
    <>
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-36 w-full" />
      <div className="flex flex-col gap-5 p-6">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </>
  );
}

type SeverityBadgeVariant = "critical" | "high" | "warn" | "secondary";

const SEVERITY_BADGE: Record<string, SeverityBadgeVariant> = {
  critical: "critical",
  high: "high",
  medium: "warn",
  low: "secondary",
};
