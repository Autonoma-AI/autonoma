interface HealthCellProps {
  activeSnapshot: {
    status: string;
    _count: { testCaseAssignments: number };
  } | null;
}

type HealthTone = "healthy" | "critical" | "running" | "unknown";

export function PRHealthCell({ activeSnapshot }: HealthCellProps) {
  const tone = computeTone(activeSnapshot);
  const label = describeTone(tone, activeSnapshot);

  return (
    <span
      className={`inline-flex items-center gap-2 border px-2 py-0.5 font-mono text-2xs font-bold uppercase tracking-widest ${toneClasses(tone)}`}
    >
      <span className={`size-1.5 ${toneDotClass(tone)}`} />
      {label}
    </span>
  );
}

function computeTone(activeSnapshot: HealthCellProps["activeSnapshot"]): HealthTone {
  if (activeSnapshot == null) return "unknown";
  if (activeSnapshot.status === "failed") return "critical";
  if (activeSnapshot.status === "processing") return "running";
  if (activeSnapshot.status === "active") return "healthy";
  return "unknown";
}

function describeTone(tone: HealthTone, activeSnapshot: HealthCellProps["activeSnapshot"]): string {
  if (tone === "critical") return "Critical";
  if (tone === "running") return "Running";
  if (tone === "healthy") {
    const count = activeSnapshot?._count.testCaseAssignments ?? 0;
    return `Healthy · ${count}`;
  }
  return "-";
}

function toneClasses(tone: HealthTone): string {
  if (tone === "critical") return "border-status-critical/40 bg-status-critical/10 text-status-critical";
  if (tone === "running") return "border-status-warn/40 bg-status-warn/10 text-status-warn";
  if (tone === "healthy") return "border-status-success/40 bg-status-success/10 text-status-success";
  return "border-border-dim bg-surface-raised text-text-tertiary";
}

function toneDotClass(tone: HealthTone): string {
  if (tone === "critical") return "bg-status-critical";
  if (tone === "running") return "bg-status-warn";
  if (tone === "healthy") return "bg-status-success";
  return "bg-text-tertiary";
}
