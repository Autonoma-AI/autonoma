import { Badge } from "@autonoma/blacklight";

export type SnapshotChangeType = "added" | "removed" | "updated";

export const CHANGE_BADGE_VARIANTS = {
  added: "success",
  removed: "critical",
  updated: "warn",
} as const;

interface SnapshotChangeRowProps {
  type: SnapshotChangeType;
  testCaseName: string;
}

export function SnapshotChangeRow({ type, testCaseName }: SnapshotChangeRowProps) {
  return (
    <div className="flex items-center justify-between border-1 border-border-dim bg-surface-raised px-5 py-4">
      <div className="flex items-center gap-3">
        <Badge variant={CHANGE_BADGE_VARIANTS[type]}>{type}</Badge>
        <span className="font-mono text-sm text-text-primary">{testCaseName}</span>
      </div>
    </div>
  );
}
