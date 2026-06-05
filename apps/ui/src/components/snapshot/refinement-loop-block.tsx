import { Badge } from "@autonoma/blacklight";
import { SentryLogsLink, TemporalLink } from "components/observability-links";
import { useAuth } from "lib/auth";
import { IterationCard } from "./iteration-card";
import { IterationStep } from "./iteration-step";
import { PipelineIds } from "./pipeline-ids";
import { iterationVisualState, type RefinementLoop } from "./refinement-types";

interface RefinementLoopBlockProps {
  loop: RefinementLoop;
  snapshotId: string;
}

const TRIGGER_LABEL: Record<RefinementLoop["triggeredBy"], string> = {
  onboarding: "onboarding",
  diffs: "diffs",
};

const STATUS_LABEL: Record<RefinementLoop["status"], string> = {
  running: "running",
  converged: "converged",
  max_iterations: "max iterations",
  error: "error",
};

const STATUS_VARIANT: Record<
  RefinementLoop["status"],
  "status-passed" | "status-failed" | "status-running" | "outline"
> = {
  running: "status-running",
  converged: "status-passed",
  max_iterations: "status-failed",
  error: "status-failed",
};

export function RefinementLoopBlock({ loop, snapshotId }: RefinementLoopBlockProps) {
  const { isAdmin } = useAuth();
  const duration = formatDuration(loop.startedAt, loop.finishedAt);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 border border-border-dim bg-surface-base px-4 py-3">
        <Badge variant="outline" className="shrink-0 font-mono uppercase">
          {TRIGGER_LABEL[loop.triggeredBy]}
        </Badge>
        <Badge variant={STATUS_VARIANT[loop.status]} className="shrink-0">
          {STATUS_LABEL[loop.status]}
        </Badge>
        <span className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
          {loop.iterations.length} iteration{loop.iterations.length === 1 ? "" : "s"}
        </span>
        {duration != null && <span className="text-2xs text-text-tertiary">· {duration}</span>}
        <PipelineIds
          ids={[
            { label: "loop", value: loop.id },
            { label: "snapshot", value: snapshotId },
          ]}
        />
        {isAdmin && (
          <div className="ml-auto flex items-center gap-2">
            <TemporalLink workflowId={`refinement-loop-${snapshotId}`} />
            <SentryLogsLink filterField="loopId" filterValue={loop.id} />
          </div>
        )}
      </div>

      <div className="flex flex-col">
        {loop.iterations.map((iter, idx) => {
          const isLast = idx === loop.iterations.length - 1;
          const state = iterationVisualState(iter, { loopStatus: loop.status, isLast });
          return (
            <IterationStep key={iter.id} number={iter.number} state={state} isLast={isLast}>
              <IterationCard iteration={iter} displayFinishedAt={state === "failed" ? loop.finishedAt : undefined} />
            </IterationStep>
          );
        })}
      </div>
    </div>
  );
}

function formatDuration(start: Date | string, end: Date | string | undefined): string | undefined {
  const startMs = new Date(start).getTime();
  const endMs = end != null ? new Date(end).getTime() : Date.now();
  const ms = endMs - startMs;
  if (ms < 0) return undefined;

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}
