import { Badge, BrailleSpinner, cn } from "@autonoma/blacklight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import type { ReactNode } from "react";
import type { IterationVisualState } from "./refinement-types";

interface IterationStepProps {
  number: number;
  state: IterationVisualState;
  isLast?: boolean;
  children: ReactNode;
}

export function IterationStep({ number, state, isLast, children }: IterationStepProps) {
  return (
    <div className="relative flex gap-4">
      <div className="flex flex-col items-center">
        <StepMarker state={state} number={number} />
        {!(isLast ?? false) && <div className={cn("mt-1 w-px flex-1", railColor(state))} />}
      </div>
      <div className={cn("flex-1 pb-6", state === "pending" && "opacity-50")}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium tracking-tight text-text-primary">Iteration {number}</h3>
          <StateBadge state={state} />
        </div>
        {children}
      </div>
    </div>
  );
}

function StepMarker({ state, number }: { state: IterationVisualState; number: number }) {
  if (state === "validated" || state === "healed") {
    return (
      <div className="flex size-7 items-center justify-center rounded-full bg-status-passed/20 text-status-passed">
        <CheckIcon size={14} weight="bold" />
      </div>
    );
  }

  if (state === "running") {
    return (
      <div className="flex size-7 items-center justify-center rounded-full bg-status-running/20 text-status-running">
        <BrailleSpinner animation="scan" size="sm" />
      </div>
    );
  }

  if (state === "no_actions") {
    return (
      <div className="flex size-7 items-center justify-center rounded-full bg-status-failed/20 text-status-failed">
        <WarningIcon size={14} weight="bold" />
      </div>
    );
  }

  return (
    <div className="flex size-7 items-center justify-center rounded-full border border-border-mid bg-surface-base text-text-tertiary">
      <span className="font-mono text-2xs">{number}</span>
    </div>
  );
}

function StateBadge({ state }: { state: IterationVisualState }) {
  switch (state) {
    case "validated":
      return (
        <Badge variant="status-passed" className="px-1.5 py-0 text-3xs">
          validated
        </Badge>
      );
    case "healed":
      return (
        <Badge variant="status-passed" className="px-1.5 py-0 text-3xs">
          healed
        </Badge>
      );
    case "running":
      return (
        <Badge variant="status-running" className="px-1.5 py-0 text-3xs">
          running
        </Badge>
      );
    case "no_actions":
      return (
        <Badge variant="status-failed" className="px-1.5 py-0 text-3xs">
          no actions
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline" className="px-1.5 py-0 text-3xs">
          upcoming
        </Badge>
      );
  }
}

function railColor(state: IterationVisualState): string {
  if (state === "validated" || state === "healed") return "bg-status-passed/40";
  if (state === "no_actions") return "bg-status-failed/40";
  return "bg-border-dim";
}
