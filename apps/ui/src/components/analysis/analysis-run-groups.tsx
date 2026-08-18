import { StatusDot, cn } from "@autonoma/blacklight";
import type { AnalysisRunFinding, AnalysisRunView } from "@autonoma/types";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { MinusIcon } from "@phosphor-icons/react/Minus";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { EmptySelectionNote } from "components/analysis/stage-empty-states";
import { analysisVerdictMeta } from "components/analysis/verdict-meta";
import { formatDuration, formatRelativeTime } from "lib/format";
import type { ReactNode } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

/**
 * The running stage's test list, grouped by verdict: the group title carries the verdict's color (mapped from
 * its Badge variant), so rows stay badge-free and aligned. "Removed" is the one merged group - a test removed
 * by the pipeline (`invalid_test`) and one removed by the PR itself end up gone either way. Rows link into the
 * finding drawer; PR-removed stubs (no finding) link to their own stub drawer.
 */
export function AnalysisRunGroups({
  run,
  prNumber,
  snapshotId,
}: {
  run: AnalysisRunView;
  prNumber: number;
  snapshotId: string;
}) {
  const groups = groupRun(run);

  if (groups.length === 0) {
    return <EmptySelectionNote />;
  }

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <section key={group.title} className="flex flex-col gap-2">
          <h3
            className={cn("flex items-center gap-2 font-mono text-3xs font-bold uppercase tracking-wider", group.color)}
          >
            {group.title}
            <span className="border border-border-dim px-1.5 text-text-secondary">{group.rows.length}</span>
          </h3>
          <ul className="flex flex-col divide-y divide-border-dim rounded-lg border border-border-dim">
            {group.rows.map((row) => (
              <li key={row.key}>
                <RunRow row={row} prNumber={prNumber} snapshotId={snapshotId} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** One row of the grouped list - a finding, or a PR-removed stub with no finding behind it. */
interface RunRow {
  key: string;
  testCase: { id: string; name: string; slug: string };
  /** The finding the row opens; absent on a PR-removed stub, which opens the stub drawer instead. */
  findingId?: string;
  secondary: string;
  change?: AnalysisRunFinding["change"];
  selfHealed: boolean;
  timing?: string;
  /** Inline live status; only rendered in the mixed "In progress" group, where the title cannot carry it. */
  status?: "running" | "queued";
}

interface RunGroup {
  title: string;
  color: string;
  rows: RunRow[];
}

function RunRow({ row, prNumber, snapshotId }: { row: RunRow; prNumber: number; snapshotId: string }) {
  const body = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-text-primary">{row.testCase.name}</span>
          <ChangeChip change={row.change} />
          {row.selfHealed && <SelfHealMark />}
        </span>
        <span className="truncate text-xs text-text-secondary">{row.secondary}</span>
      </div>
      <span className="shrink-0 text-right font-mono text-3xs text-text-secondary">{row.timing}</span>
      {row.status === "running" && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-status-warn">
          <CircleNotchIcon size={12} className="animate-spin" /> Running
        </span>
      )}
      {row.status === "queued" && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-text-secondary">
          <StatusDot status="neutral" /> Queued
        </span>
      )}
    </>
  );
  const rowClass = "flex items-center gap-4 px-4 py-2.5 text-left transition-colors hover:bg-surface-raised";

  if (row.findingId != null) {
    return (
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/running/finding/$findingId"
        params={{ prNumber, snapshotId, findingId: row.findingId }}
        className={rowClass}
      >
        {body}
      </AppLink>
    );
  }
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/running/removed/$testCaseId"
      params={{ prNumber, snapshotId, testCaseId: row.testCase.id }}
      className={rowClass}
    >
      {body}
    </AppLink>
  );
}

/** Neutral by design: color stays reserved for statuses and verdicts, so a change chip is a quiet outline. */
const CHANGE_META: Record<NonNullable<AnalysisRunFinding["change"]>, { label: string; icon: ReactNode }> = {
  created: { label: "Created", icon: <PlusIcon size={10} /> },
  edited: { label: "Edited", icon: <PencilSimpleIcon size={10} /> },
  removed: { label: "Removed", icon: <MinusIcon size={10} /> },
};

function ChangeChip({ change }: { change: AnalysisRunFinding["change"] }) {
  if (change == null) return undefined;
  const meta = CHANGE_META[change];
  return (
    <span className="inline-flex shrink-0 items-center gap-1 border border-border-mid px-1.5 py-0.5 font-mono text-4xs font-bold uppercase tracking-wider text-text-secondary">
      {meta.icon}
      {meta.label}
    </span>
  );
}

function SelfHealMark() {
  return (
    <span
      title="Self-healed: the plan was rewritten during this run"
      className="inline-flex shrink-0 items-center gap-1 font-mono text-4xs font-bold uppercase tracking-wider text-text-secondary"
    >
      <ArrowsClockwiseIcon size={11} /> Self-healed
    </span>
  );
}

/** The group heading carries the verdict's color; mapped from its Badge variant so it cannot drift. */
const VARIANT_HEADING_COLOR: Record<string, string> = {
  critical: "text-status-critical",
  high: "text-status-high",
  warn: "text-status-warn",
  success: "text-status-success",
  secondary: "text-text-secondary",
  outline: "text-text-primary",
};

function headingColorFor(verdict: string): string {
  return VARIANT_HEADING_COLOR[analysisVerdictMeta(verdict).variant] ?? "text-text-secondary";
}

function toRow(finding: AnalysisRunFinding): RunRow {
  return {
    key: finding.findingId,
    testCase: finding.testCase,
    findingId: finding.findingId,
    secondary: finding.verdict?.headline ?? finding.selectionReason ?? finding.testCase.slug,
    change: finding.change,
    selfHealed: finding.selfHealed,
    timing: timingOf(finding),
    status: statusOf(finding),
  };
}

function timingOf(finding: AnalysisRunFinding): string | undefined {
  if (finding.startedAt != null && finding.completedAt != null) {
    return `Ran for ${formatDuration(finding.completedAt.getTime() - finding.startedAt.getTime())}`;
  }
  if (finding.startedAt != null) return `Started ${formatRelativeTime(finding.startedAt)}`;
  return undefined;
}

function statusOf(finding: AnalysisRunFinding): RunRow["status"] {
  if (finding.verdict != null || finding.contained) return undefined;
  return finding.generationStatus === "running" ? "running" : "queued";
}

function groupRun(run: AnalysisRunView): RunGroup[] {
  // One pass: bucket every finding by its group key. An unjudged finding is either still in progress or a crashed
  // investigation; a judged one buckets by verdict category. Verdict groups are then drained from the map in
  // display order, and whatever verdict is left over (a taxonomy addition with no explicit home here) still gets
  // its own group, so a finding is never silently dropped from the list.
  const byVerdict = new Map<string, AnalysisRunFinding[]>();
  const inProgress: AnalysisRunFinding[] = [];
  const contained: AnalysisRunFinding[] = [];
  for (const finding of run.findings) {
    if (finding.verdict == null) {
      (finding.contained ? contained : inProgress).push(finding);
      continue;
    }
    const bucket = byVerdict.get(finding.verdict.category) ?? [];
    bucket.push(finding);
    byVerdict.set(finding.verdict.category, bucket);
  }

  const take = (verdict: string): RunRow[] => {
    const rows = (byVerdict.get(verdict) ?? []).map(toRow);
    byVerdict.delete(verdict);
    return rows;
  };

  const removedStubs: RunRow[] = run.removedTests.map((removed) => ({
    key: `removed-${removed.testCase.id}`,
    testCase: removed.testCase,
    secondary: "Removed by this checkpoint's changes",
    change: "removed",
    selfHealed: false,
  }));

  const groups: RunGroup[] = [
    { title: "In progress", color: "text-status-warn", rows: inProgress.map(toRow) },
    verdictGroup("client_bug", take),
    verdictGroup("plan_mismatch", take),
    verdictGroup("engine_artifact", take),
    verdictGroup("environment_failure", take),
    verdictGroup("scenario_issue", take),
    {
      title: "Removed",
      color: headingColorFor("invalid_test"),
      rows: [...take("invalid_test"), ...removedStubs],
    },
    {
      title: "Investigation crashed",
      color: "text-status-high",
      rows: contained.map((finding) => ({
        ...toRow(finding),
        secondary: "The investigation crashed before judging a run",
      })),
    },
    verdictGroup("passed", take),
    ...[...byVerdict.keys()].map((verdict) => verdictGroup(verdict, take)),
  ];
  return groups.filter((group) => group.rows.length > 0);
}

function verdictGroup(verdict: string, take: (verdict: string) => RunRow[]): RunGroup {
  return { title: analysisVerdictMeta(verdict).label, color: headingColorFor(verdict), rows: take(verdict) };
}
