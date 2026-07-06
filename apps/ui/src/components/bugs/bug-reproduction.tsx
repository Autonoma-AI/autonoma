import { stepInstruction } from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { ListNumbersIcon } from "@phosphor-icons/react/ListNumbers";
import type { RouterOutputs } from "lib/trpc";
import { useState } from "react";

type BugDetail = RouterOutputs["bugs"]["detail"];
type LatestOccurrence = NonNullable<BugDetail["latestOccurrence"]>;
type ReproductionStep = LatestOccurrence["reproductionSteps"][number];

// Fully collapsed by default: the factual run step list is reference material, not the
// story. Text-only (no per-step screenshots); the failing step gets only a subtle marker.
export function BugReproduction({ latest }: { latest: LatestOccurrence | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const steps = latest?.reproductionSteps ?? [];

  return (
    <div className="border border-border-dim bg-surface-base">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-surface-raised/40"
      >
        <ListNumbersIcon size={12} className="text-text-secondary" />
        <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
          Steps to reproduce
        </span>
        {steps.length > 0 && <span className="font-mono text-2xs text-text-secondary">{steps.length}</span>}
        <CaretDownIcon
          size={12}
          className={`ml-auto text-text-secondary transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div className="border-t border-border-dim">
          {steps.length === 0 ? (
            <p className="px-4 py-3 text-sm text-text-secondary">
              No ordered run steps were captured for this occurrence.
            </p>
          ) : (
            <ol>
              {steps.map((step) => (
                <StepRow key={step.order} step={step} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: ReproductionStep }) {
  return (
    <li className="flex gap-3 border-b border-border-dim px-4 py-2.5 last:border-b-0">
      <span
        className={`mt-px w-5 shrink-0 text-right font-mono text-2xs ${
          step.isFailing ? "text-status-critical" : "text-text-secondary"
        }`}
      >
        {step.order}
      </span>
      <div className="min-w-0">
        <p className={`break-words text-sm ${step.isFailing ? "text-status-critical" : "text-text-primary"}`}>
          {stepInstruction(step)}
          {step.isFailing && (
            <span className="ml-2 font-mono text-3xs uppercase tracking-widest text-status-critical">failed here</span>
          )}
        </p>
        {step.outcome != null && (
          <p className="mt-1 break-words text-xs leading-relaxed text-text-secondary">{step.outcome}</p>
        )}
      </div>
    </li>
  );
}
