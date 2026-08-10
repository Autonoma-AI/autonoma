import { Badge, Button, Card, CardContent } from "@autonoma/blacklight";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import type { NamedRun, TestAwaitingRun } from "lib/query/snapshot-edit.queries";
import { useEditSession, useStartRuns } from "lib/query/snapshot-edit.queries";
import { AppLink } from "../../../-app-link";

const STATUS_BADGE_VARIANT = {
  pending: "status-pending",
  queued: "status-pending",
  running: "status-running",
  success: "status-passed",
  failed: "status-failed",
} as const;

export function GenerationsTab({ snapshotId }: { snapshotId: string }) {
  const { data: session } = useEditSession(snapshotId);
  const startRuns = useStartRuns();

  const runAll = () =>
    startRuns.mutate({ snapshotId, testCaseIds: session.testsAwaitingRun.map((test) => test.testCaseId) });

  return (
    <div className="grid h-[calc(100dvh-340px)] grid-cols-3 gap-4">
      <Column
        title="Not run"
        count={session.testsAwaitingRun.length}
        action={
          session.testsAwaitingRun.length > 0 ? (
            <Button size="xs" onClick={runAll} disabled={startRuns.isPending}>
              <LightningIcon size={12} />
              {startRuns.isPending ? "Starting..." : "Generate all"}
            </Button>
          ) : undefined
        }
        emptyMessage="Every changed test has been run"
      >
        {session.testsAwaitingRun.map((test) => (
          <AwaitingRunCard key={test.testCaseId} test={test} />
        ))}
      </Column>

      <Column title="In Progress" count={session.activeRuns.length} emptyMessage="No runs in progress">
        {session.activeRuns.map((run) => (
          <RunCard key={run.runId} run={run} />
        ))}
      </Column>

      <Column title="Completed" count={session.finishedRuns.length} emptyMessage="No completed runs">
        {session.finishedRuns.map((run) => (
          <RunCard key={run.runId} run={run} />
        ))}
      </Column>
    </div>
  );
}

// ─── Column ─────────────────────────────────────────────────────────────────

interface ColumnProps {
  title: string;
  count: number;
  action?: React.ReactNode;
  emptyMessage: string;
  children: React.ReactNode;
}

function Column({ title, count, action, emptyMessage, children }: ColumnProps) {
  return (
    <div className="flex flex-col overflow-hidden border border-border-mid bg-surface-raised">
      <div className="flex shrink-0 items-center justify-between border-b border-border-dim px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary">{title}</span>
          <Badge variant="secondary" className="px-1.5 py-0 text-3xs">
            {count}
          </Badge>
        </div>
        {action}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {count === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-2xs text-text-secondary">{emptyMessage}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">{children}</div>
        )}
      </div>
    </div>
  );
}

// ─── Cards ──────────────────────────────────────────────────────────────────

function AwaitingRunCard({ test }: { test: TestAwaitingRun }) {
  return (
    <Card variant="raised" size="default">
      <CardContent className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-sm text-text-primary">{test.testCaseName}</span>
      </CardContent>
    </Card>
  );
}

function RunCard({ run }: { run: NamedRun }) {
  return (
    <AppLink to="/app/$appSlug/generations/$generationId" params={{ generationId: run.runId }}>
      <Card variant="raised" size="default" className="transition-colors hover:bg-surface-base">
        <CardContent className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-sm text-text-primary">{run.testCaseName}</span>
          <Badge variant={STATUS_BADGE_VARIANT[run.status]} className="shrink-0">
            {run.status}
          </Badge>
        </CardContent>
      </Card>
    </AppLink>
  );
}
