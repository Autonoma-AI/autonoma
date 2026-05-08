import { WarningOctagonIcon } from "@phosphor-icons/react/WarningOctagon";
import { computeStageStatuses, type DiffsJob, type SnapshotChange } from "./diffs-timeline-types";
import { StageAnalysis } from "./stage-analysis";
import { StageFinalization } from "./stage-finalization";
import { StageGeneration } from "./stage-generation";
import { StageReplay } from "./stage-replay";
import { StageResolution } from "./stage-resolution";
import { TimelineStage } from "./timeline-stage";

interface DiffsTimelineProps {
  diffsJob: DiffsJob;
  changes: SnapshotChange[];
}

export function DiffsTimeline({ diffsJob, changes }: DiffsTimelineProps) {
  const stageStatuses = computeStageStatuses(diffsJob);
  const duration = formatDuration(diffsJob.startedAt, diffsJob.completedAt);

  return (
    <div className="flex flex-col gap-4">
      {diffsJob.failureReason != null && (
        <div className="flex items-start gap-3 border border-status-critical/40 bg-status-critical/5 px-4 py-3">
          <WarningOctagonIcon size={16} className="mt-0.5 shrink-0 text-status-critical" />
          <div className="flex flex-col gap-1">
            <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-status-critical">
              Diffs job failed
            </span>
            <p className="text-sm text-text-secondary">{diffsJob.failureReason}</p>
          </div>
        </div>
      )}

      {duration != null && (
        <div className="flex items-center gap-2 text-2xs text-text-tertiary">
          <span className="font-mono uppercase tracking-widest">Duration</span>
          <span>{duration}</span>
        </div>
      )}

      <div className="flex flex-col">
        <TimelineStage index={0} title="Analysis" status={stageStatuses.analysis}>
          <StageAnalysis job={diffsJob} />
        </TimelineStage>

        <TimelineStage index={1} title="Replay" status={stageStatuses.replay}>
          <StageReplay job={diffsJob} />
        </TimelineStage>

        <TimelineStage index={2} title="Resolution" status={stageStatuses.resolution}>
          <StageResolution job={diffsJob} />
        </TimelineStage>

        <TimelineStage index={3} title="Generation" status={stageStatuses.generation}>
          <StageGeneration job={diffsJob} />
        </TimelineStage>

        <TimelineStage index={4} title="Finalization" status={stageStatuses.finalization} isLast>
          <StageFinalization changes={changes} />
        </TimelineStage>
      </div>
    </div>
  );
}

function formatDuration(start: Date | null | undefined, end: Date | null | undefined): string | undefined {
  if (start == null) return undefined;
  const endTime = end ?? new Date();
  const ms = endTime.getTime() - new Date(start).getTime();
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
