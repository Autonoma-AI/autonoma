import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { PlayCircleIcon } from "@phosphor-icons/react/PlayCircle";
import { QuestionIcon } from "@phosphor-icons/react/Question";
import { WarningOctagonIcon } from "@phosphor-icons/react/WarningOctagon";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { cn } from "../../lib/utils";

export type SnapshotHealth = "healthy" | "critical" | "running" | "unknown";

export interface SnapshotHealthCounts {
  failing: number;
  passing: number;
  running: number;
  quarantined: number;
  notAffected: number;
  totalTests: number;
}

type Tone = "success" | "critical" | "warn" | "neutral";

export function describeSnapshotHealth(snapshotStatus: string, counts: SnapshotHealthCounts): string {
  if (snapshotStatus === "failed") return "Checkpoint failed to process";
  if (counts.failing > 0) {
    return `${counts.failing} of ${counts.totalTests} ${counts.totalTests === 1 ? "test" : "tests"} failing`;
  }
  if (counts.quarantined > 0) {
    return `${counts.quarantined} ${counts.quarantined === 1 ? "test" : "tests"} quarantined`;
  }
  if (counts.running > 0) return "Tests are still running";
  if (counts.passing > 0 && counts.notAffected === 0) return "All affected tests passing";
  if (counts.notAffected === counts.totalTests - counts.quarantined) return "No tests affected by this PR";
  return `${counts.notAffected} of ${counts.totalTests} not affected by this PR`;
}

export function PrHealthPill({ health, className }: { health: SnapshotHealth; className?: string }) {
  if (health === "critical") {
    return (
      <span
        className={cn(
          "inline-flex items-center border border-status-critical bg-status-critical/10 px-3 py-1 font-mono text-2xs font-bold uppercase tracking-widest text-status-critical",
          className,
        )}
      >
        Critical
      </span>
    );
  }
  if (health === "healthy") {
    return (
      <span
        className={cn(
          "inline-flex items-center border border-status-success bg-status-success/10 px-3 py-1 font-mono text-2xs font-bold uppercase tracking-widest text-status-success",
          className,
        )}
      >
        Healthy
      </span>
    );
  }
  if (health === "running") {
    return (
      <span
        className={cn(
          "inline-flex items-center border border-status-warn bg-status-warn/10 px-3 py-1 font-mono text-2xs font-bold uppercase tracking-widest text-status-warn",
          className,
        )}
      >
        Running
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center border border-border-mid bg-surface-raised px-3 py-1 font-mono text-2xs font-bold uppercase tracking-widest text-text-tertiary",
        className,
      )}
    >
      Not replayed
    </span>
  );
}

export function HealthBreakdown({ counts }: { counts: SnapshotHealthCounts }) {
  const items: Array<{ key: keyof SnapshotHealthCounts; label: string; tone: Tone }> = [
    { key: "failing", label: `${counts.failing} failing`, tone: "critical" },
    { key: "passing", label: `${counts.passing} passing`, tone: "success" },
    { key: "running", label: `${counts.running} running`, tone: "warn" },
    { key: "notAffected", label: `${counts.notAffected} not affected`, tone: "neutral" },
    { key: "quarantined", label: `${counts.quarantined} quarantined`, tone: "critical" },
  ];

  if (counts.totalTests === 0) {
    return <BreakdownRow tone="neutral" label="No tests in this checkpoint" />;
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <BreakdownRow key={item.key} tone={item.tone} label={item.label} muted={counts[item.key] === 0} />
      ))}
    </div>
  );
}

function BreakdownRow({ tone, label, muted = false }: { tone: Tone; label: string; muted?: boolean }) {
  const Icon =
    tone === "critical"
      ? XCircleIcon
      : tone === "success"
        ? CheckCircleIcon
        : tone === "warn"
          ? PlayCircleIcon
          : QuestionIcon;

  const colorClass = muted
    ? "text-text-tertiary"
    : tone === "critical"
      ? "text-status-critical"
      : tone === "success"
        ? "text-status-success"
        : tone === "warn"
          ? "text-status-warn"
          : "text-text-secondary";

  return (
    <div className={cn("flex items-center gap-2 text-sm", colorClass)}>
      <Icon size={14} />
      <span>{label}</span>
    </div>
  );
}

export function HealthStat({
  value,
  label,
  tone = "neutral",
}: {
  value: number;
  label: string;
  tone?: "neutral" | "critical";
}) {
  const valueClass = tone === "critical" && value > 0 ? "text-status-critical" : "text-text-primary";
  const iconClass = tone === "critical" && value > 0 ? "text-status-critical" : "text-text-tertiary";

  return (
    <div className="flex flex-col items-start justify-center gap-1">
      <span className={cn("font-mono text-lg leading-none", valueClass)}>{value}</span>
      <span className={cn("flex items-center gap-1 font-mono text-2xs uppercase tracking-widest", iconClass)}>
        {label === "quarantined" && value > 0 && <WarningOctagonIcon size={10} />}
        {label}
      </span>
    </div>
  );
}
