import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { LockIcon } from "@phosphor-icons/react/Lock";
import { useState } from "react";
import type { InjectedVar } from "./variable-model";

/**
 * The reserved variables PreviewKit injects into every deployment, collapsed by
 * default and deliberately quieter than the user-defined list: read-only, no
 * selection, no editing.
 */
export function InjectedBlock({ vars }: { vars: InjectedVar[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border-dim bg-surface-void/60">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-raised/40"
      >
        {expanded ? (
          <CaretDownIcon size={11} className="shrink-0 text-text-secondary" />
        ) : (
          <CaretRightIcon size={11} className="shrink-0 text-text-secondary" />
        )}
        <span className="font-mono text-3xs font-semibold uppercase tracking-widest text-text-secondary">
          Injected by PreviewKit · {vars.length}
        </span>
        <span className="ml-auto border border-border-mid bg-surface-raised px-1.5 py-px font-mono text-4xs font-semibold uppercase tracking-wider text-text-secondary">
          Read-only
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-border-dim/60 px-3.5 pb-3 pt-2">
          {vars.map((variable) => (
            <div
              key={variable.key}
              className="grid grid-cols-[minmax(9rem,0.7fr)_1fr] items-baseline gap-3 py-1.5"
              title={variable.description}
            >
              <span className="flex items-center gap-2 truncate font-mono text-xs text-text-secondary">
                <LockIcon size={11} className="shrink-0" />
                <span className="truncate">{variable.key}</span>
                <span className="shrink-0 border border-border-mid px-1 py-px font-mono text-4xs uppercase tracking-wider text-text-secondary">
                  {variable.source}
                </span>
              </span>
              <span className="truncate font-mono text-2xs text-text-secondary/70">{variable.example}</span>
            </div>
          ))}
          <p className="mt-1.5 text-2xs text-text-secondary">
            Injected automatically and reserved - you can't set these.
          </p>
        </div>
      ) : undefined}
    </div>
  );
}
