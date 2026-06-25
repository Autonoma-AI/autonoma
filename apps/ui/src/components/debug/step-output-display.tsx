import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { useState } from "react";

interface StepOutputDisplayProps {
  output: Record<string, unknown>;
}

function renderValue(value: unknown): React.ReactNode {
  if (value == null) return <span className="text-text-tertiary">null</span>;
  if (typeof value === "string")
    return <span className="whitespace-pre-wrap break-words text-text-secondary">{value}</span>;
  if (typeof value === "number") return <span className="font-mono text-text-secondary">{value}</span>;
  if (typeof value === "boolean")
    return (
      <span className={`font-mono text-xs ${value ? "text-status-success" : "text-status-critical"}`}>
        {value ? "true" : "false"}
      </span>
    );
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-text-tertiary">[]</span>;
    return (
      <ul className="ml-2 list-disc space-y-0.5">
        {value.map((item, i) => (
          <li key={i} className="text-xs text-text-secondary">
            {renderValue(item)}
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-text-tertiary">{"{}"}</span>;
    return (
      <div className="ml-2 space-y-0.5">
        {entries.map(([k, v]) => (
          <KeyValueRow key={k} label={k} value={v} />
        ))}
      </div>
    );
  }
  return <span className="font-mono text-xs text-text-secondary">{String(value)}</span>;
}

function KeyValueRow({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex items-start gap-2">
      <span className="shrink-0 font-mono text-3xs text-text-tertiary">{label}</span>
      <span className="min-w-0 break-words text-xs">{renderValue(value)}</span>
    </div>
  );
}

export function StepOutputDisplay({ output }: StepOutputDisplayProps) {
  const [expanded, setExpanded] = useState(false);

  const entries = Object.entries(output);
  if (entries.length === 0) return null;

  return (
    <div className="mt-2 border-t border-border-dim pt-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center gap-1.5 font-mono text-3xs text-text-tertiary transition-colors hover:text-text-secondary"
      >
        <CaretDownIcon size={10} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
        Step output
      </button>
      {expanded && (
        <div className="mt-2 space-y-1.5 rounded bg-surface-base p-2">
          {entries.map(([key, value]) => (
            <KeyValueRow key={key} label={key} value={value} />
          ))}
        </div>
      )}
    </div>
  );
}
