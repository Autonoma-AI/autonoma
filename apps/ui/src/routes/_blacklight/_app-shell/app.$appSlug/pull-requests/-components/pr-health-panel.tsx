import { Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { HeartbeatIcon } from "@phosphor-icons/react/Heartbeat";
import { PlayCircleIcon } from "@phosphor-icons/react/PlayCircle";
import { QuestionIcon } from "@phosphor-icons/react/Question";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { useBranchRuns } from "lib/query/runs.queries";
import type { RouterOutputs } from "lib/trpc";

type Snapshot = RouterOutputs["branches"]["snapshotHistory"][number];
type Run = RouterOutputs["runs"]["list"][number];

type HealthStatus = "healthy" | "critical" | "running" | "unknown";

export function PRHealthPanel({ applicationId, snapshot }: { applicationId: string; snapshot: Snapshot }) {
  const { data: runs, isPending } = useBranchRuns(applicationId, snapshot.id);

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Health</PanelTitle>
      </PanelHeader>
      <PanelBody className="p-0">
        {isPending ? <HealthSkeleton /> : <HealthContent snapshot={snapshot} runs={runs ?? []} />}
      </PanelBody>
    </Panel>
  );
}

function HealthContent({ snapshot, runs }: { snapshot: Snapshot; runs: Run[] }) {
  const counts = countRuns(runs);
  const status = computeHealthStatus(snapshot, counts);
  const changeCount = snapshot.changeSummary.added + snapshot.changeSummary.updated + snapshot.changeSummary.removed;
  const testCount = snapshot._count.testCaseAssignments;

  return (
    <>
      <div className="flex flex-col items-center gap-4 px-5 pt-8 pb-6">
        <HealthHeroIcon status={status} />
        <HealthBadge status={status} />
        <p className="text-center text-sm text-text-secondary">{describeStatus(status, counts)}</p>
      </div>

      <div className="border-t border-border-dim px-5 py-4">
        <HealthBreakdown status={status} counts={counts} />
      </div>

      <div className="grid grid-cols-3 border-t border-border-dim">
        <Stat value={runs.length} label="runs" />
        <Stat value={testCount} label="tests" />
        <Stat value={changeCount} label="edited" />
      </div>
    </>
  );
}

function countRuns(runs: Run[]) {
  const counts = { success: 0, failed: 0, running: 0, pending: 0 };
  for (const run of runs) {
    if (run.status === "success") counts.success += 1;
    else if (run.status === "failed") counts.failed += 1;
    else if (run.status === "running") counts.running += 1;
    else if (run.status === "pending") counts.pending += 1;
  }
  return counts;
}

function computeHealthStatus(snapshot: Snapshot, counts: ReturnType<typeof countRuns>): HealthStatus {
  if (snapshot.status === "failed") return "critical";
  if (counts.failed > 0) return "critical";
  if (counts.running > 0 || counts.pending > 0 || snapshot.status === "processing") return "running";
  if (counts.success > 0) return "healthy";
  return "unknown";
}

function describeStatus(status: HealthStatus, counts: ReturnType<typeof countRuns>): string {
  if (status === "critical") {
    if (counts.failed > 0) return "Tests are failing - action required";
    return "Snapshot failed to process";
  }
  if (status === "healthy") return "All tests passing, no failures";
  if (status === "running") return "Tests are still running";
  return "No runs yet for this snapshot";
}

function HealthHeroIcon({ status }: { status: HealthStatus }) {
  const colorClass =
    status === "critical"
      ? "text-status-critical"
      : status === "healthy"
        ? "text-status-success"
        : status === "running"
          ? "text-status-warn"
          : "text-text-tertiary";

  const beatDuration =
    status === "critical"
      ? "[animation-duration:2s]"
      : status === "running"
        ? "[animation-duration:2.6s]"
        : status === "healthy"
          ? "[animation-duration:3.2s]"
          : "[animation-duration:4s]";

  return (
    <HeartbeatIcon
      size={56}
      weight="duotone"
      className={`origin-center cursor-default hover:animate-heartbeat ${beatDuration} ${colorClass}`}
    />
  );
}

function HealthBadge({ status }: { status: HealthStatus }) {
  if (status === "critical") {
    return (
      <span className="inline-flex items-center border border-status-critical bg-status-critical/10 px-3 py-1 font-mono text-2xs font-bold uppercase tracking-widest text-status-critical">
        Critical
      </span>
    );
  }
  if (status === "healthy") {
    return (
      <span className="inline-flex items-center border border-status-success bg-status-success/10 px-3 py-1 font-mono text-2xs font-bold uppercase tracking-widest text-status-success">
        Healthy
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center border border-status-warn bg-status-warn/10 px-3 py-1 font-mono text-2xs font-bold uppercase tracking-widest text-status-warn">
        Running
      </span>
    );
  }
  return (
    <span className="inline-flex items-center border border-border-mid bg-surface-raised px-3 py-1 font-mono text-2xs font-bold uppercase tracking-widest text-text-tertiary">
      Unknown
    </span>
  );
}

function HealthBreakdown({ status, counts }: { status: HealthStatus; counts: ReturnType<typeof countRuns> }) {
  const items: Array<{ key: string; label: string; tone: "success" | "critical" | "warn" | "neutral" }> = [];

  if (counts.failed > 0) {
    items.push({
      key: "failed",
      label: `${counts.failed} ${counts.failed === 1 ? "test" : "tests"} failing`,
      tone: "critical",
    });
  }
  if (counts.success > 0) {
    const allPassing = counts.failed === 0 && counts.running === 0 && counts.pending === 0;
    items.push({
      key: "success",
      label: allPassing
        ? `${counts.success} ${counts.success === 1 ? "test" : "tests"} passing`
        : `${counts.success} passing`,
      tone: "success",
    });
  }
  if (counts.running > 0) {
    items.push({ key: "running", label: `${counts.running} running`, tone: "warn" });
  }
  if (counts.pending > 0) {
    items.push({ key: "pending", label: `${counts.pending} pending`, tone: "warn" });
  }

  if (status === "unknown" && items.length === 0) {
    return <BreakdownRow tone="neutral" label="No runs yet" />;
  }
  if (status === "healthy" && items.length === 1) {
    return (
      <div className="flex flex-col gap-2">
        <BreakdownRow tone="success" label={items[0]!.label} />
        <BreakdownRow tone="success" label="No failures" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <BreakdownRow key={item.key} tone={item.tone} label={item.label} />
      ))}
    </div>
  );
}

function BreakdownRow({ tone, label }: { tone: "success" | "critical" | "warn" | "neutral"; label: string }) {
  const Icon =
    tone === "critical"
      ? XCircleIcon
      : tone === "success"
        ? CheckCircleIcon
        : tone === "warn"
          ? PlayCircleIcon
          : QuestionIcon;

  const colorClass =
    tone === "critical"
      ? "text-status-critical"
      : tone === "success"
        ? "text-status-success"
        : tone === "warn"
          ? "text-status-warn"
          : "text-text-tertiary";

  return (
    <div className={`flex items-center gap-2 text-sm ${colorClass}`}>
      <Icon size={14} />
      <span>{label}</span>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 border-r border-border-dim px-3 py-4 last:border-r-0">
      <span className="font-mono text-lg text-text-primary">{value}</span>
      <span className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">{label}</span>
    </div>
  );
}

function HealthSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-5">
      <Skeleton className="mx-auto h-14 w-14" />
      <Skeleton className="mx-auto h-4 w-24" />
      <Skeleton className="mx-auto h-4 w-48" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
