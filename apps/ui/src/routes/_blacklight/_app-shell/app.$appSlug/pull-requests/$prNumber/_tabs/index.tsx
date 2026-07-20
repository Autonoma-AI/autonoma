import { Badge, Panel, PanelBody, Skeleton, StatusDot } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { useSuspenseQueries } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { AnalysisJobStatus } from "components/analysis/analysis-job-status";
import { AnalysisFindingsPanel } from "components/analysis/findings-panel";
import { PrVerdictHeadline } from "components/analysis/pr-verdict-headline";
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
import {
  ensureAnalysisJobData,
  ensureAnalysisReportData,
  ensureBranchByPrData,
  ensureSnapshotHistoryData,
  latestSnapshotOf,
  sortSnapshotsNewestFirst,
  useAnalysisJob,
  useAuthoritativeAnalysisReport,
  useBranchByPr,
  useSnapshotHistory,
} from "lib/query/branches.queries";
import { useBugsListByBranch } from "lib/query/bugs.queries";
import { useCommitFromGitHub } from "lib/query/github.queries";
import { trpc } from "lib/trpc";
import type { RouterOutputs } from "lib/trpc";
import { Suspense, useMemo } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { CheckpointSummaryBadge } from "../../-components/checkpoint-summary-badge";
import { ExecutedTestLink } from "../../-components/executed-test-link";
import { formatCheckpointMetrics } from "../../-components/format-checkpoint-metrics";

type Snapshot = RouterOutputs["branches"]["snapshotHistory"][number];
type SnapshotDetail = RouterOutputs["branches"]["snapshotDetail"];
type Bug = RouterOutputs["bugs"]["listByBranch"][number];
type PRTestEntry = TestEntry & { snapshotId: string };
type PRTestSection = Omit<Section, "entries"> & { entries: PRTestEntry[] };
type ExecutedTest = SnapshotDetail["executedTests"][number];
type PRExecutedTest = ExecutedTest & { snapshotId: string; category?: EntryCategory };
type PRTestRunSection = { key: string; title: string; entries: PRExecutedTest[] };

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/_tabs/")({
  loader: async ({ context, params: { appSlug, prNumber } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    const branch = await ensureBranchByPrData(context.queryClient, app.id, prNumber);
    // Prefetch the latest snapshot's analysis job + report so the authoritative-vs-diffs gate resolves without a
    // client-side waterfall. Both resolve to null for a diffs PR (cheap), leaving today's layout untouched.
    const snapshots = await ensureSnapshotHistoryData(context.queryClient, branch.id);
    const latest = latestSnapshotOf(snapshots);
    if (latest != null) {
      await Promise.all([
        ensureAnalysisJobData(context.queryClient, latest.id),
        ensureAnalysisReportData(context.queryClient, latest.id),
      ]);
    }
  },
  component: OverviewTab,
});

function OverviewTab() {
  const { prNumber } = Route.useParams();

  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <OverviewContent prNumber={prNumber} />
    </Suspense>
  );
}

function OverviewContent({ prNumber }: { prNumber: number }) {
  const app = useCurrentApplication();
  const { data: branch } = useBranchByPr(app.id, prNumber);
  const { data: snapshots } = useSnapshotHistory(branch.id);
  const orderedSnapshots = sortSnapshotsNewestFirst(snapshots);
  const latestSnapshot = orderedSnapshots[0];

  if (latestSnapshot == null) {
    return (
      <div className="p-6">
        <NoSnapshotsPanel />
      </div>
    );
  }

  return (
    <PrOverview
      applicationId={app.id}
      branchId={branch.id}
      prNumber={prNumber}
      snapshots={orderedSnapshots}
      latestSnapshot={latestSnapshot}
    />
  );
}

// The overview gate. An authoritative snapshot (the merged pipeline ran on it, so it has an `AnalysisJob`) gets
// the findings-first layout; every other PR - shadow/diffs alike - renders exactly as before. The job also
// distinguishes a still-running authoritative snapshot (no report yet) from a diffs one, which the report-presence
// gate alone cannot.
function PrOverview({
  applicationId,
  branchId,
  prNumber,
  snapshots,
  latestSnapshot,
}: {
  applicationId: string;
  branchId: string;
  prNumber: number;
  snapshots: Snapshot[];
  latestSnapshot: Snapshot;
}) {
  const { data: analysisJob } = useAnalysisJob(latestSnapshot.id);

  if (analysisJob == null) {
    return (
      <PullRequestDetailWithCheckpoint
        applicationId={applicationId}
        branchId={branchId}
        prNumber={prNumber}
        snapshots={snapshots}
        latestSnapshot={latestSnapshot}
      />
    );
  }

  return (
    <AuthoritativePrOverview
      prNumber={prNumber}
      snapshots={snapshots}
      latestSnapshot={latestSnapshot}
      analysisJob={analysisJob}
    />
  );
}

// The authoritative PR overview: the two-plane verdict headline + the latest snapshot's full findings list in the
// main column, with the checkpoint-history rail retained. While the run is still in flight (no report yet), the
// main column falls back to the `AnalysisJob` status and polls until the report lands. The cross-PR aggregation
// card and the "Checkpoints in this PR" list are intentionally gone.
function AuthoritativePrOverview({
  prNumber,
  snapshots,
  latestSnapshot,
  analysisJob,
}: {
  prNumber: number;
  snapshots: Snapshot[];
  latestSnapshot: Snapshot;
  analysisJob: NonNullable<RouterOutputs["branches"]["analysisJob"]>;
}) {
  const { data: report } = useAuthoritativeAnalysisReport(latestSnapshot.id, analysisJob.status === "running");

  return (
    <div className="p-6">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {report != null ? (
            <>
              <PrVerdictHeadline findings={report.findings} />
              <AnalysisFindingsPanel findings={report.findings} prNumber={prNumber} snapshotId={latestSnapshot.id} />
              <LatestSnapshotLink prNumber={prNumber} snapshotId={latestSnapshot.id} />
            </>
          ) : (
            <AnalysisJobStatus job={analysisJob} />
          )}
        </div>
        <CheckpointRail prNumber={prNumber} snapshots={snapshots} />
      </div>
    </div>
  );
}

// A quiet link to the latest snapshot's report, where the impact-analysis reasoning, findings summary, and test
// suite changes live in full - detail the trimmed PR overview deliberately omits.
function LatestSnapshotLink({ prNumber, snapshotId }: { prNumber: number; snapshotId: string }) {
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
      params={{ prNumber, snapshotId }}
      className="inline-flex items-center gap-1 self-start font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary"
    >
      View impact analysis and suite changes
      <ArrowRightIcon size={12} />
    </AppLink>
  );
}

function PullRequestDetailWithCheckpoint({
  applicationId,
  branchId,
  prNumber,
  snapshots,
  latestSnapshot,
}: {
  applicationId: string;
  branchId: string;
  prNumber: number;
  snapshots: Snapshot[];
  latestSnapshot: Snapshot;
}) {
  const { data: bugs } = useBugsListByBranch(branchId, "open");

  return (
    <div className="flex flex-col gap-5 p-6">
      <CheckpointsSection
        applicationId={applicationId}
        prNumber={prNumber}
        snapshots={snapshots}
        latestSnapshot={latestSnapshot}
        bugs={bugs}
      />
    </div>
  );
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
  const suiteChangeCount = useMemo(() => countSuiteChanges(testChangeSections), [testChangeSections]);
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
        <CompactTestsRun
          sections={testRunSections}
          suiteChangeCount={suiteChangeCount}
          prNumber={prNumber}
          snapshotId={latestSnapshot.id}
        />
      </div>
    </div>
  );
}

function countSuiteChanges(sections: PRTestSection[]): number {
  return sections.reduce(
    (sum, section) =>
      sum +
      section.entries.filter((e) => e.category === "added" || e.category === "modified" || e.category === "removed")
        .length,
    0,
  );
}

function useSnapshotDetails(snapshots: Snapshot[]): SnapshotDetail[] {
  return useSuspenseQueries({
    queries: snapshots.map((snapshot) => trpc.branches.snapshotDetail.queryOptions({ snapshotId: snapshot.id })),
    combine: (results) => results.map((result) => result.data as SnapshotDetail),
  });
}

const TEST_CATEGORY_ORDER: EntryCategory[] = ["modified", "added", "checked", "removed"];

const TEST_CATEGORY_TITLE: Record<EntryCategory, string> = {
  added: "Added",
  modified: "Edited",
  checked: "Checked",
  removed: "Removed",
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
      createdTests: detail.createdTests,
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
  const status = entry.generation?.status;
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
    ["setup_failed", { key: "setup_failed", title: "Setup Failed", entries: [] }],
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
  if (test.finalOutcome === "setup_failed") return "setup_failed";
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

function CompactTestsRun({
  sections,
  suiteChangeCount,
  prNumber,
  snapshotId,
}: {
  sections: PRTestRunSection[];
  suiteChangeCount: number;
  prNumber: number;
  snapshotId: string;
}) {
  if (sections.length === 0) {
    // No executed tests yet; surface suite changes when the suite was edited.
    return (
      <div className="flex flex-col gap-2 bg-surface-void px-4 py-4 text-sm text-text-secondary">
        <span>No tests have run for this PR yet.</span>
        {suiteChangeCount > 0 && (
          <span className="text-text-secondary">
            {suiteChangeCount} test suite {suiteChangeCount === 1 ? "change" : "changes"} were made -{" "}
            <AppLink
              to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/changes"
              params={{ prNumber, snapshotId }}
              className="text-text-primary hover:underline"
            >
              view test suite changes
            </AppLink>
            .
          </span>
        )}
      </div>
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
              <ExecutedTestRunRow key={`${entry.snapshotId}-${entry.testCase.id}`} test={entry} />
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

function ExecutedTestRunRow({ test }: { test: PRExecutedTest }) {
  return (
    <li className="border-t border-border-dim/60">
      <ExecutedTestLink
        test={test}
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
      </ExecutedTestLink>
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
    { key: "setup_failed", label: "setup failed", count: finalOutcomeCount("setup_failed"), variant: "warn" },
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

function categoryVariant(
  category: TestEntry["category"],
): "success" | "warn" | "critical" | "high" | "outline" | "neutral" {
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
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
      params={{ prNumber, snapshotId: snapshot.id }}
      className="flex flex-col gap-2 border-b border-border-dim px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-raised"
    >
      <div className="flex flex-wrap items-center gap-2">
        {isLatest && (
          <Badge
            variant="outline"
            className="gap-1 border-border-mid font-mono uppercase tracking-wider text-text-secondary"
          >
            {snapshot.summary != null && <StatusDot status={dotStatusForTone(snapshot.summary.tone)} />}
            Latest
          </Badge>
        )}
        {snapshot.summary != null && <CheckpointSummaryBadge summary={snapshot.summary} />}
        <span className="ml-auto font-mono text-2xs text-text-tertiary">{formatRelativeTime(snapshot.createdAt)}</span>
      </div>
      <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
      <span className="font-mono text-2xs text-text-tertiary">
        {formatCheckpointMetrics(snapshot.summary, snapshot.bugCount, snapshot.healthCounts.totalTests)}
      </span>
    </AppLink>
  );
}

function dotStatusForTone(
  tone: "success" | "critical" | "warning" | "neutral",
): "success" | "critical" | "warn" | "neutral" {
  if (tone === "success") return "success";
  if (tone === "critical") return "critical";
  if (tone === "warning") return "warn";
  return "neutral";
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

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-5 p-6">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  );
}

type SeverityBadgeVariant = "critical" | "high" | "warn" | "secondary";

const SEVERITY_BADGE: Record<string, SeverityBadgeVariant> = {
  critical: "critical",
  high: "high",
  medium: "warn",
  low: "secondary",
};
