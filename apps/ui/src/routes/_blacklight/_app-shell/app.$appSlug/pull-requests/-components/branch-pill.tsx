import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";

export function BranchPill({ name, emphasize }: { name: string; emphasize?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 border border-border-dim bg-surface-raised px-2 py-0.5 font-mono text-2xs">
      <GitBranchIcon size={10} className="text-text-tertiary" />
      <span className={emphasize ? "text-primary-ink" : "text-text-secondary"}>{name}</span>
    </span>
  );
}
