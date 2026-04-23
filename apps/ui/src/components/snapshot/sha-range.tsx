import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";

interface ShaRangeProps {
  baseSha: string | null;
  headSha: string | null;
}

export function ShaRange({ baseSha, headSha }: ShaRangeProps) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-xs text-text-secondary">
      <code className="rounded bg-surface-subtle px-1.5 py-0.5">{baseSha != null ? baseSha.slice(0, 7) : "-"}</code>
      <ArrowRightIcon size={10} className="text-text-tertiary" />
      <code className="rounded bg-surface-subtle px-1.5 py-0.5">{headSha != null ? headSha.slice(0, 7) : "-"}</code>
    </div>
  );
}
