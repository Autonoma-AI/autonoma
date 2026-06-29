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
        <span className="size-1.5 shrink-0 bg-text-tertiary" />-
      </span>
    );
  }

  // Keep the pill within its fixed-width column: the dot and label never shrink, while the
  // optional reason truncates. Without this the `nowrap` reason overflows and forces the table
  // to scroll horizontally. The full text stays available via the title attribute.
  return (
    <span
      title={summary.reason != null ? `${summary.label} · ${summary.reason}` : summary.label}
      className={`flex min-w-0 max-w-full items-center gap-2 border px-2 py-0.5 font-mono text-2xs font-bold uppercase tracking-widest ${toneClasses(summary.tone)}`}
    >
      <span className={`size-1.5 shrink-0 ${toneDotClass(summary.tone)}`} />
      <span className="shrink-0 whitespace-nowrap">{summary.label}</span>
      {summary.reason != null && (
        <span className="min-w-0 truncate font-normal normal-case opacity-70">· {summary.reason}</span>
      )}
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
