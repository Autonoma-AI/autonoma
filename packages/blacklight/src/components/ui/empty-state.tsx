import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 border border-border-dim bg-surface-raised/40 px-6 py-12 text-center",
        className,
      )}
    >
      {icon != null ? <div className="text-text-tertiary">{icon}</div> : null}
      <div className="space-y-1">
        <h3 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">{title}</h3>
        {description != null ? <p className="text-sm text-text-secondary">{description}</p> : null}
      </div>
      {action != null ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}
