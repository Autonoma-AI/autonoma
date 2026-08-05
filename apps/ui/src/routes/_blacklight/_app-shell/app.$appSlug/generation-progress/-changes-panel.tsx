import { Badge, Card, CardContent } from "@autonoma/blacklight";
import { CHANGE_BADGE_VARIANTS } from "components/snapshot/change-badge-variants";
import type { RouterOutputs } from "lib/trpc";

type SnapshotChange = RouterOutputs["snapshotEdit"]["get"]["changes"][number];

export function ChangesPanel({ changes }: { changes: SnapshotChange[] }) {
  return (
    <div className="flex flex-col overflow-hidden border border-border-mid bg-surface-raised">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-dim px-4 py-3">
        <span className="text-sm font-medium text-text-primary">Changes</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-3xs">
          {changes.length}
        </Badge>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {changes.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-2xs text-text-secondary">No changes in this snapshot</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {changes.map((change) => (
              <ChangeCard key={change.testCaseId} change={change} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChangeCard({ change }: { change: SnapshotChange }) {
  return (
    <Card variant="raised" size="default">
      <CardContent className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-sm text-text-primary">{change.testCaseName}</span>
        <Badge variant={CHANGE_BADGE_VARIANTS[change.type]} className="shrink-0">
          {change.type}
        </Badge>
      </CardContent>
    </Card>
  );
}
