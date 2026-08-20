"use client";

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

/**
 * Nothing has EVER happened in this container, as opposed to nothing being here right now - which is
 * {@link EmptyState}. A skeleton is never the zero state: a persistent skeleton is a bug, a persistent zero state
 * is correct.
 */
export interface ZeroStateStep {
  label: string;
  detail?: ReactNode;
}

export interface ZeroStateAction {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
}

export interface ZeroStateProps {
  /** A Phosphor icon at size 28-32. */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  steps?: ZeroStateStep[];
  /**
   * What this is waiting on, when something is already in flight. SUPPRESSES `action` - that rule lives here
   * rather than at each call site so no surface can offer a button for work that is already under way.
   */
  pending?: string;
  action?: ZeroStateAction;
  /** `panel` for a page section (bordered); `bare` inside a rail, a table body or an existing Panel. */
  variant?: "panel" | "bare";
  className?: string;
}

export function ZeroState({
  icon,
  title,
  description,
  steps,
  pending,
  action,
  variant = "panel",
  className,
}: ZeroStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4",
        variant === "panel" ? "border border-border-dim bg-surface-raised/40 px-6 py-8" : "px-4 py-6",
        className,
      )}
    >
      {icon != null ? <div className="text-text-secondary">{icon}</div> : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-balance text-sm font-medium text-text-primary">{title}</h3>
        {description != null ? (
          <p className="text-pretty text-sm leading-relaxed text-text-secondary">{description}</p>
        ) : null}
      </div>

      {steps != null && steps.length > 0 ? <StepList steps={steps} /> : null}

      {pending != null ? (
        <span className="font-mono text-3xs uppercase tracking-widest text-text-secondary">{pending}</span>
      ) : null}

      {/* Work already in flight leaves nothing for the reader to start, so the action is withheld rather than
          inviting them to begin it twice. */}
      {pending == null && action != null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={action.onClick}>
            {action.icon}
            {action.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function StepList({ steps }: { steps: ZeroStateStep[] }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {steps.map((step, index) => (
        <li key={step.label} className="flex gap-2.5">
          <span className="mt-0.5 grid size-4 shrink-0 place-items-center border border-border-mid font-mono text-4xs text-text-secondary">
            {index + 1}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-xs leading-relaxed text-text-primary">{step.label}</span>
            {step.detail != null ? (
              <span className="text-xs leading-relaxed text-text-secondary">{step.detail}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
