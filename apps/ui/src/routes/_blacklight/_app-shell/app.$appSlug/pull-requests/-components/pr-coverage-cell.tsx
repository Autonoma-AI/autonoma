import type { CheckpointPresentationSummary, CheckpointTone } from "@autonoma/types";

interface HealthCellProps {
  activeSnapshot: {
    status: string;
    _count: { testCaseAssignments: number };
    summary?: CheckpointPresentationSummary;
  } | null;
}

export function PRHealthCell({ activeSnapshot }: HealthCellProps) {
  const summary = activeSnapshot?.summary;
  if (summary == null) {
    return (
      <span className="inline-flex items-center gap-2 whitespace-nowrap border border-border-dim bg-surface-raised px-2 py-0.5 font-mono text-2xs font-bold uppercase tracking-widest text-text-secondary">
        <span className="size-1.5 bg-text-tertiary" />-
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap border px-2 py-0.5 font-mono text-2xs font-bold uppercase tracking-widest ${toneClasses(summary.tone)}`}
    >
      <span className={`size-1.5 ${toneDotClass(summary.tone)}`} />
      {summary.label}
      {summary.reason != null && <span className="font-normal normal-case opacity-70">· {summary.reason}</span>}
    </span>
  );
}

function toneClasses(tone: CheckpointTone): string {
  if (tone === "critical") return "border-status-critical/40 bg-status-critical/10 text-status-critical";
  if (tone === "warning") return "border-status-warn/40 bg-status-warn/10 text-status-warn";
  if (tone === "success") return "border-status-success/40 bg-status-success/10 text-status-success";
  return "border-border-dim bg-surface-raised text-text-secondary";
}

function toneDotClass(tone: CheckpointTone): string {
  if (tone === "critical") return "bg-status-critical";
  if (tone === "warning") return "bg-status-warn";
  if (tone === "success") return "bg-status-success";
  return "bg-text-tertiary";
}
