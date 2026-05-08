import { Badge } from "@autonoma/blacklight";
import { AffectedTestRow } from "./affected-test-row";
import type { AffectedTest, DiffsJob } from "./diffs-timeline-types";
import { StageEmpty } from "./stage-empty";

type RunStatus = NonNullable<AffectedTest["run"]>["status"];
type RunVerdict = NonNullable<NonNullable<AffectedTest["run"]>["runReview"]>["verdict"];

const RUN_STATUS_BADGE: Record<RunStatus, "status-pending" | "status-running" | "status-passed" | "status-failed"> = {
  pending: "status-pending",
  running: "status-running",
  success: "status-passed",
  failed: "status-failed",
};

const VERDICT_BADGE: Record<NonNullable<RunVerdict>, { label: string; variant: "warn" | "critical" }> = {
  engine_error: { label: "engine error", variant: "warn" },
  application_bug: { label: "app bug", variant: "critical" },
};

interface StageReplayProps {
  job: DiffsJob;
}

export function StageReplay({ job }: StageReplayProps) {
  const tests = job.affectedTests.filter((t) => t.run != null);

  if (tests.length === 0) {
    return <StageEmpty message="No replays scheduled" />;
  }

  return (
    <div className="flex flex-col gap-1.5">
      {tests.map((test) => (
        <AffectedTestRow
          key={test.testCase.id}
          test={test}
          showReasoning={false}
          nameLink={{ kind: "run", runId: test.run!.id }}
          rightSlot={<RunBadges run={test.run!} />}
        />
      ))}
    </div>
  );
}

function RunBadges({ run }: { run: NonNullable<AffectedTest["run"]> }) {
  const verdict = run.runReview?.verdict;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Badge variant={RUN_STATUS_BADGE[run.status]}>{run.status}</Badge>
      {verdict != null && <Badge variant={VERDICT_BADGE[verdict].variant}>{VERDICT_BADGE[verdict].label}</Badge>}
    </div>
  );
}
