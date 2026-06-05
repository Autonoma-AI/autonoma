import { cn } from "@autonoma/blacklight";

interface PipelineId {
  label: string;
  value: string | null | undefined;
}

interface PipelineIdsProps {
  ids: PipelineId[];
  className?: string;
}

export function PipelineIds({ ids, className }: PipelineIdsProps) {
  const visibleIds = ids.filter((id): id is { label: string; value: string } => id.value != null && id.value !== "");
  if (visibleIds.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {visibleIds.map((id) => (
        <span
          key={`${id.label}:${id.value}`}
          className="inline-flex min-w-0 items-center gap-1 border border-border-dim bg-surface-base px-1.5 py-0.5 font-mono text-[10px] text-text-tertiary"
        >
          <span className="uppercase tracking-wider">{id.label}</span>
          <code className="break-all text-text-secondary">{id.value}</code>
        </span>
      ))}
    </div>
  );
}
