const SCENARIO_STATUSES: Record<string, { label: string; className: string }> = {
  REQUESTED: { label: "Requested", className: "bg-status-pending/10 text-status-pending" },
  UP_SUCCESS: { label: "Up OK", className: "bg-status-success/10 text-status-success" },
  UP_FAILED: { label: "Up Failed", className: "bg-status-critical/10 text-status-critical" },
  RUNNING_TESTS: { label: "Running", className: "bg-status-running/10 text-status-running" },
  DOWN_SUCCESS: { label: "Down OK", className: "bg-status-success/10 text-status-success" },
  DOWN_FAILED: { label: "Down Failed", className: "bg-status-critical/10 text-status-critical" },
};

const SNAPSHOT_STATUSES: Record<string, { label: string; className: string }> = {
  processing: { label: "Processing", className: "bg-status-running/10 text-status-running" },
  active: { label: "Active", className: "bg-status-success/10 text-status-success" },
  superseded: { label: "Superseded", className: "bg-text-tertiary/10 text-text-tertiary" },
  failed: { label: "Failed", className: "bg-status-critical/10 text-status-critical" },
};

const FALLBACK = { className: "bg-text-tertiary/10 text-text-tertiary" };

function StatusBadge({ label, className }: { label: string; className: string }) {
  return <span className={`rounded px-1.5 py-0.5 font-mono text-3xs ${className}`}>{label}</span>;
}

export function ScenarioStatusBadge({ status }: { status: string }) {
  const entry = SCENARIO_STATUSES[status] ?? { label: status, ...FALLBACK };
  return <StatusBadge label={entry.label} className={entry.className} />;
}

export function SnapshotStatusBadge({ status }: { status: string }) {
  const entry = SNAPSHOT_STATUSES[status] ?? { label: status, ...FALLBACK };
  return <StatusBadge label={entry.label} className={entry.className} />;
}
