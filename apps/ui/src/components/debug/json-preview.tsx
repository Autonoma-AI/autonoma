import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { useState } from "react";

interface JsonPreviewProps {
  data: unknown;
  label: string;
}

/** Collapsible JSON viewer. Returns null when `data` is nullish. */
export function JsonPreview({ data, label }: JsonPreviewProps) {
  const [expanded, setExpanded] = useState(false);

  if (data == null) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center gap-1.5 font-mono text-3xs text-text-tertiary transition-colors hover:text-text-secondary"
      >
        <CaretDownIcon size={10} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
        {label}
      </button>
      {expanded && (
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-surface-base p-2 font-mono text-3xs text-text-secondary">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}
