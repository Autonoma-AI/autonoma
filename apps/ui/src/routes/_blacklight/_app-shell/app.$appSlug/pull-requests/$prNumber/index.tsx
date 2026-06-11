import { Badge, Button, Panel, PanelBody, Skeleton, StatusDot } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { useSuspenseQueries } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ScreenshotLightbox } from "components/screenshot-lightbox";
import { ShaRange } from "components/snapshot/sha-range";
import {
  CATEGORY,
  buildSections,
  type EntryCategory,
  type Section,
  type TestEntry,
} from "components/snapshot/snapshot-entries";
import { formatRelativeTime } from "lib/format";
import { ensureBranchByPrData, useBranchByPr, useSnapshotDetail, useSnapshotHistory } from "lib/query/branches.queries";
import { useBugsListByPr } from "lib/query/bugs.queries";
import { ensurePreviewEnvironmentSummaryData } from "lib/query/deployments.queries";
import {
  useApplicationRepositoryFromGitHub,
  useCommitFromGitHub,
  usePullRequestFromGitHub,
} from "lib/query/github.queries";
import { trpc } from "lib/trpc";
import type { RouterOutputs } from "lib/trpc";
import { Suspense, useMemo } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { PRDetailHeader } from "../-components/pr-detail-header";

type Snapshot = RouterOutputs["branches"]["snapshotHistory"][number];
type SnapshotDetail = RouterOutputs["branches"]["snapshotDetail"];
type Bug = RouterOutputs["bugs"]["listByPr"][number];
type PullRequest = RouterOutputs["github"]["getPullRequest"];
type Repository = RouterOutputs["github"]["getApplicationRepository"];
type PRTestEntry = TestEntry & { snapshotId: string };
type PRTestSection = Omit<Section, "entries"> & { entries: PRTestEntry[] };
type ExecutedTest = SnapshotDetail["executedTests"][number];
type PRExecutedTest = ExecutedTest & { snapshotId: string; category?: EntryCategory };
type PRTestRunSection = { key: string; title: string; entries: PRExecutedTest[] };

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
  const { data: bugs } = useBugsListByPr(applicationId, branchId, "open");
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
        <CheckpointsSection
          applicationId={applicationId}
          prNumber={prNumber}
          snapshots={snapshots}
          latestSnapshot={latestSnapshot}
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
  bugs,
}: {
  applicationId: string;
  prNumber: number;
  snapshots: Snapshot[];
  latestSnapshot: Snapshot;
  bugs: Bug[];
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Checkpoints in this PR</h2>
        <span className="font-mono text-2xs text-text-tertiary">
          · {snapshots.length} {snapshots.length === 1 ? "checkpoint" : "checkpoints"} · sorted newest
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <Suspense fallback={<AggregatedCheckpointCardSkeleton />}>
          <AggregatedCheckpointCard
            applicationId={applicationId}
            prNumber={prNumber}
            snapshots={snapshots}
            latestSnapshot={latestSnapshot}
            bugs={bugs}
          />
        </Suspense>
        <CheckpointRail prNumber={prNumber} snapshots={snapshots} />
      </div>
    </section>
  );
}

function CheckpointRail({ prNumber, snapshots }: { prNumber: number; snapshots: Snapshot[] }) {
  return (
    <aside className="flex min-h-0 flex-col border border-border-dim bg-surface-base">
      <div className="border-b border-border-dim px-4 py-3">
        <h3 className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">
          Checkpoint history
        </h3>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {snapshots.map((snapshot, index) => (
          <Suspense key={snapshot.id} fallback={<CheckpointRailItemSkeleton snapshot={snapshot} />}>
            <CheckpointRailItem prNumber={prNumber} snapshot={snapshot} isLatest={index === 0} />
          </Suspense>
        ))}
      </div>
    </aside>
  );
}

function AggregatedCheckpointCard({
  applicationId,
  prNumber,
  snapshots,
  latestSnapshot,
  bugs,
}: {
  applicationId: string;
  prNumber: number;
  snapshots: Snapshot[];
  latestSnapshot: Snapshot;
  bugs: Bug[];
}) {
  const { data: commit } = useCommitFromGitHub(applicationId, latestSnapshot.headSha ?? undefined);
  const latestCommitMessage = commit?.message.split("\n")[0];
  const details = useSnapshotDetails(snapshots);
  const oldestSnapshot = snapshots[snapshots.length - 1] ?? latestSnapshot;
  const testChangeSections = useMemo(() => buildCumulativeTestChangeSections(details), [details]);
  const testRunSections = useMemo(
    () => buildPrTestRunSections(details, testChangeSections),
    [details, testChangeSections],
  );
  const testRunSummary = useMemo(() => buildTestRunSummary(testRunSections), [testRunSections]);
  const hasBugs = bugs.length > 0;

  return (
    <div className="border border-border-dim bg-surface-base">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-dim px-5 py-3">
        <Badge
          variant="outline"
          className={
            hasBugs
              ? "gap-1 border-status-critical/60 bg-status-critical/10 font-mono uppercase tracking-wider text-status-critical"
              : "gap-1 border-primary-ink bg-primary-ink/10 font-mono uppercase tracking-wider text-primary-ink"
          }
        >
          <StatusDot status={hasBugs ? "critical" : "success"} />
          PR Overview
        </Badge>
        <ShaRange baseSha={oldestSnapshot.baseSha} headSha={latestSnapshot.headSha} />
        {latestCommitMessage != null && (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{latestCommitMessage}</span>
        )}
        <div className="ml-auto flex items-center gap-3 font-mono text-2xs text-text-tertiary">
          <span>
            {snapshots.length} {snapshots.length === 1 ? "checkpoint" : "checkpoints"}
          </span>
          <span>·</span>
          <span>{formatRelativeTime(latestSnapshot.createdAt)}</span>
        </div>
      </div>

      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold tracking-tight text-text-primary">
            {bugs.length === 0 ? "Tests run across this PR" : "Bugs found in this PR"}
          </h2>
          {bugs.length === 0 && <TestChangeSummary items={testRunSummary} />}
          {bugs.length === 0 && <TestSuiteChangesButton prNumber={prNumber} snapshotId={latestSnapshot.id} />}
        </div>

        {bugs.length > 0 && (
          <div className="flex flex-col gap-2">
            {bugs.map((bug) => (
              <CheckpointBugRow key={bug.id} bug={bug} />
            ))}
          </div>
        )}

        {bugs.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <h2 className="text-lg font-semibold tracking-tight text-text-primary">Tests run across this PR</h2>
            <TestChangeSummary items={testRunSummary} />
            <TestSuiteChangesButton prNumber={prNumber} snapshotId={latestSnapshot.id} />
          </div>
        )}
        <CompactTestsRun sections={testRunSections} prNumber={prNumber} />
      </div>
    </div>
  );
}

function useSnapshotDetails(snapshots: Snapshot[]): SnapshotDetail[] {
  return useSuspenseQueries({
    queries: snapshots.map((snapshot) => trpc.branches.snapshotDetail.queryOptions({ snapshotId: snapshot.id })),
    combine: (results) => results.map((result) => result.data as SnapshotDetail),
  });
}

const TEST_CATEGORY_ORDER: EntryCategory[] = [
  "modified",
  "added",
  "removed",
  "newly-quarantined",
  "proposed-pending",
  "proposed-rejected",
];

const TEST_CATEGORY_TITLE: Record<EntryCategory, string> = {
  added: "Added",
  modified: "Edited",
  removed: "Removed",
  "newly-quarantined": "Newly quarantined",
  "proposed-pending": "Proposed",
  "proposed-rejected": "Rejected",
};

function buildCumulativeTestChangeSections(details: SnapshotDetail[]): PRTestSection[] {
  const entriesByCategory = new Map<EntryCategory, PRTestEntry[]>(
    TEST_CATEGORY_ORDER.map((category) => [category, []]),
  );
  const seen = new Set<string>();

  for (const detail of details) {
    const snapshotId = detail.snapshot.id;
    const sections = buildSections({
      changes: detail.changes,
      affectedTests: detail.diffsJob.affectedTests,
      testCandidates: detail.diffsJob.testCandidates,
      quarantinedTests: detail.quarantinedTests,
      executedTests: detail.executedTests,
    });

    for (const section of sections) {
      for (const entry of section.entries) {
        const key = entry.testSlug ?? entry.urlId;
        if (seen.has(key)) continue;
        seen.add(key);
        entriesByCategory.get(entry.category)?.push({ ...entry, snapshotId });
      }
    }
  }

  return TEST_CATEGORY_ORDER.map((category) => ({
    title: TEST_CATEGORY_TITLE[category],
    entries: sortTestEntries(entriesByCategory.get(category) ?? []),
  }));
}

function sortTestEntries(entries: PRTestEntry[]): PRTestEntry[] {
  return [...entries].sort((a, b) => testEntryPriority(a) - testEntryPriority(b));
}

function testEntryPriority(entry: TestEntry): number {
  const status = entry.run?.status ?? entry.generation?.status;
  if (status === "failed") return 0;
  if (entry.category === "modified") return 1;
  if (status === "running" || status === "pending" || status === "queued") return 2;
  if (status === "success") return 9;
  return 3;
}

function buildPrTestRunSections(details: SnapshotDetail[], testChangeSections: PRTestSection[]): PRTestRunSection[] {
  const categoryByTestCaseId = new Map<string, EntryCategory>();
  for (const section of testChangeSections) {
    for (const entry of section.entries) {
      if (!categoryByTestCaseId.has(entry.urlId)) categoryByTestCaseId.set(entry.urlId, entry.category);
    }
  }

  // Include in-flight (unresolved) tests so this card agrees with the checkpoint report header
  // and the checkpoint history rail, which never drop running tests. Dropping them here made the
  // PR card report fewer tests than the rest of the UI while a checkpoint was still running.
  const sections = new Map<string, PRTestRunSection>([
    ["failed", { key: "failed", title: "Failed", entries: [] }],
    ["running", { key: "running", title: "Running", entries: [] }],
    ["passed", { key: "passed", title: "Passed", entries: [] }],
  ]);
  const seen = new Set<string>();

  for (const detail of details) {
    for (const test of detail.executedTests) {
      if (seen.has(test.testCase.id)) continue;
      seen.add(test.testCase.id);

      const category = categoryByTestCaseId.get(test.testCase.id);
      const entry: PRExecutedTest = { ...test, snapshotId: detail.snapshot.id, category };
      const groupKey = groupKeyForExecutedTest(entry);
      sections.get(groupKey)?.entries.push(entry);
    }
  }

  return [...sections.values()]
    .map((section) => ({ ...section, entries: sortExecutedTests(section.entries) }))
    .filter((section) => section.entries.length > 0);
}

function groupKeyForExecutedTest(test: PRExecutedTest): string {
  if (test.finalOutcome === "failed") return "failed";
  if (test.finalOutcome === "passed") return "passed";
  return "running";
}

function sortExecutedTests(tests: PRExecutedTest[]): PRExecutedTest[] {
  return [...tests].sort((a, b) => b.latestRunAt.getTime() - a.latestRunAt.getTime());
}

function TestSuiteChangesButton({ prNumber, snapshotId }: { prNumber: number; snapshotId: string }) {
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/changes"
      params={{ prNumber, snapshotId }}
      className="ml-auto inline-flex items-center gap-1 font-mono text-2xs font-semibold uppercase tracking-widest text-text-primary transition-colors hover:underline"
    >
      View test suite changes
      <ArrowRightIcon size={12} />
    </AppLink>
  );
}

function CompactTestsRun({ sections, prNumber }: { sections: PRTestRunSection[]; prNumber: number }) {
  const app = useCurrentApplication();

  if (sections.length === 0) {
    return (
      <div className="bg-surface-void px-4 py-4 text-sm text-text-secondary">No test runs recorded across this PR.</div>
    );
  }

  return (
    <div className="flex flex-col">
      {sections.map((section) => (
        <details key={section.key} className="group border-b border-border-dim last:border-b-0">
          <summary className="flex cursor-pointer list-none items-center gap-2 py-3 transition-colors hover:text-text-primary">
            <CaretRightIcon size={12} className="text-text-tertiary transition-transform group-open:rotate-90" />
            <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
              {section.title} · {section.entries.length}
            </span>
          </summary>
          <ul>
            {section.entries.map((entry) => (
              <ExecutedTestRunRow
                key={`${entry.snapshotId}-${entry.testCase.id}`}
                test={entry}
                appSlug={app.slug}
                prNumber={prNumber}
              />
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

function ExecutedTestRunRow({ test, appSlug, prNumber }: { test: PRExecutedTest; appSlug: string; prNumber: number }) {
  return (
    <li className="border-t border-border-dim/60">
      <Link
        to="/app/$appSlug/pull-requests/$prNumber/suite"
        params={{ appSlug, prNumber }}
        search={{ testSlug: test.testCase.slug }}
        className="flex min-w-0 flex-col gap-1 py-2.5 transition-colors hover:text-primary-ink"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-mono text-xs text-text-primary">{test.testCase.name}</span>
          {test.category != null && (
            <Badge variant={categoryVariant(test.category)} className="shrink-0 text-3xs">
              {categoryLabel(test.category)}
            </Badge>
          )}
        </div>
        {test.reviewReasoning != null && test.reviewReasoning.trim().length > 0 && (
          <p className="line-clamp-2 text-xs leading-relaxed text-text-tertiary">{test.reviewReasoning}</p>
        )}
      </Link>
    </li>
  );
}

type SummaryItem = {
  key: string;
  label: string;
  count: number;
  variant:
    | "status-passed"
    | "status-failed"
    | "status-running"
    | "status-pending"
    | "success"
    | "warn"
    | "critical"
    | "outline";
};

function buildTestRunSummary(sections: PRTestRunSection[]): SummaryItem[] {
  const entries = sections.flatMap((section) => section.entries);
  const finalOutcomeCount = (finalOutcome: ExecutedTest["finalOutcome"]) =>
    entries.filter((entry) => entry.finalOutcome === finalOutcome).length;

  const summary: SummaryItem[] = [
    { key: "failed", label: "failed", count: finalOutcomeCount("failed"), variant: "status-failed" },
    { key: "running", label: "running", count: finalOutcomeCount("unresolved"), variant: "status-running" },
    { key: "passed", label: "passed", count: finalOutcomeCount("passed"), variant: "status-passed" },
  ];

  return summary.filter((item) => item.count > 0);
}

function TestChangeSummary({ items }: { items: SummaryItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((item) => (
        <Badge key={item.key} variant={item.variant} className="font-mono text-3xs">
          {item.count} {item.label}
        </Badge>
      ))}
    </div>
  );
}

function categoryLabel(category: TestEntry["category"]): string {
  if (category === "modified") return "edited";
  return CATEGORY[category].label;
}

function categoryVariant(category: TestEntry["category"]): "success" | "warn" | "critical" | "high" | "outline" {
  if (category === "added") return "outline";
  return CATEGORY[category].variant;
}

function CheckpointBugRow({ bug }: { bug: Bug }) {
  const primaryTestCase = bug.testCases[0];
  const testLabel = primaryTestCase?.slug ?? primaryTestCase?.name ?? "No linked test case";

  return (
    <div className="flex items-center gap-3 border border-border-dim bg-surface-void p-2 transition-colors hover:border-border-mid hover:bg-surface-raised">
      {bug.thumbnail?.url != null ? (
        <ScreenshotLightbox
          src={bug.thumbnail.url}
          alt={bug.title}
          className="h-14 w-24 shrink-0 border border-border-mid object-cover"
        />
      ) : (
        <div className="h-14 w-24 shrink-0 border border-border-mid bg-[repeating-linear-gradient(45deg,var(--surface-base),var(--surface-base)_6px,transparent_6px,transparent_12px)]" />
      )}
      <AppLink to="/app/$appSlug/bugs/$bugId" params={{ bugId: bug.id }} className="min-w-0 flex-1">
        <Badge
          variant="outline"
          className="mb-1 border-status-critical/50 bg-status-critical/10 font-mono text-3xs uppercase tracking-wider text-status-critical"
        >
          Bug
        </Badge>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-text-primary">{bug.title}</span>
          <Badge variant={SEVERITY_BADGE[bug.severity] ?? "secondary"}>{bug.severity}</Badge>
        </div>
        {bug.description.trim() !== "" && (
          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-text-secondary">{bug.description}</p>
        )}
        <div className="mt-1 truncate font-mono text-2xs text-text-tertiary">
          {testLabel} · x{bug.occurrences} {bug.occurrences === 1 ? "occurrence" : "occurrences"}
        </div>
      </AppLink>
    </div>
  );
}

function CheckpointRailItem({
  prNumber,
  snapshot,
  isLatest,
}: {
  prNumber: number;
  snapshot: Snapshot;
  isLatest: boolean;
}) {
  const isHealthy = snapshot.health === "healthy" && snapshot.bugCount === 0;

  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
      params={{ prNumber, snapshotId: snapshot.id }}
      className="flex flex-col gap-2 border-b border-border-dim px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-raised"
    >
      <div className="flex items-center gap-2">
        {isLatest ? (
          <Badge
            variant="outline"
            className={
              isHealthy
                ? "gap-1 border-primary-ink bg-primary-ink/10 font-mono uppercase tracking-wider text-primary-ink"
                : "gap-1 border-status-critical/60 bg-status-critical/10 font-mono uppercase tracking-wider text-status-critical"
            }
          >
            <StatusDot status={isHealthy ? "success" : "critical"} />
            Latest
          </Badge>
        ) : isHealthy ? (
          <Badge variant="success" className="font-mono uppercase tracking-wider">
            Healthy
          </Badge>
        ) : snapshot.bugCount > 0 ? (
          <Badge
            variant="outline"
            className="border-status-critical/60 bg-status-critical/10 font-mono uppercase tracking-wider text-status-critical"
          >
            {snapshot.bugCount} {snapshot.bugCount === 1 ? "bug" : "bugs"}
          </Badge>
        ) : (
          <Badge variant="outline" className="font-mono uppercase tracking-wider text-text-tertiary">
            0 bugs
          </Badge>
        )}
        <span className="ml-auto font-mono text-2xs text-text-tertiary">{formatRelativeTime(snapshot.createdAt)}</span>
      </div>
      <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
      <span className="font-mono text-2xs text-text-tertiary">
        {checkpointMetricText(snapshot.healthCounts, snapshot.bugCount)}
      </span>
    </AppLink>
  );
}

function checkpointMetricText(counts: SnapshotDetail["healthCounts"], bugCount: number): string {
  const parts: string[] = [];
  if (counts.failing > 0) parts.push(`${counts.failing} failed`);
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.passing > 0) parts.push(`${counts.passing} passed`);
  if (bugCount > 0) parts.push(`${bugCount} ${bugCount === 1 ? "bug" : "bugs"}`);
  if (parts.length > 0) return parts.join(" · ");
  return `${counts.totalTests} tests`;
}

function CheckpointRailItemSkeleton({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border-dim px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="ml-auto h-3 w-12" />
      </div>
      <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
      <Skeleton className="h-4 w-full" />
    </div>
  );
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

function AggregatedCheckpointCardSkeleton() {
  return (
    <div className="border border-border-dim bg-surface-base">
      <div className="flex items-center gap-3 border-b border-border-dim px-5 py-3">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-6 w-36" />
        <Skeleton className="ml-auto h-3 w-28" />
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-28 w-full" />
      </div>
    </div>
  );
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
