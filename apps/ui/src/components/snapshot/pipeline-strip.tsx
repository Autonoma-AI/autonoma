import { Badge, BrailleSpinner, cn, Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { WarningOctagonIcon } from "@phosphor-icons/react/WarningOctagon";
import { useState } from "react";
import {
  computeStageStatuses,
  type DiffsJob,
  type SnapshotChange,
  type StageKey,
  type StageStatus,
} from "./diffs-timeline-types";
import { PipelineIds } from "./pipeline-ids";
import type { RefinementLoop } from "./refinement-types";
import { StageAnalysis } from "./stage-analysis";
import { StageFinalization } from "./stage-finalization";
import { StageGeneration } from "./stage-generation";
import { StageReplay } from "./stage-replay";
import { StageResolution } from "./stage-resolution";

interface PipelineStripProps {
  diffsJob: DiffsJob;
  changes: SnapshotChange[];
  refinementLoop: RefinementLoop | undefined;
  snapshotId: string;
}

const STAGES: Array<{ key: StageKey; title: string }> = [
  { key: "analysis", title: "Analysis" },
  { key: "replay", title: "Replay" },
  { key: "resolution", title: "Resolution" },
  { key: "generation", title: "Generation" },
  { key: "finalization", title: "Finalization" },
];

export function PipelineStrip({ diffsJob, changes, refinementLoop, snapshotId }: PipelineStripProps) {
  const stageStatuses = computeStageStatuses(diffsJob);
  const failedStage = STAGES.find(({ key }) => stageStatuses[key] === "failed")?.key;
  const currentStage = STAGES.find(({ key }) => stageStatuses[key] === "current")?.key;
  const [expanded, setExpanded] = useState<StageKey | undefined>(failedStage ?? currentStage);
  const duration = formatDuration(diffsJob.startedAt, diffsJob.completedAt);

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Pipeline</PanelTitle>
        <PipelineIds ids={[{ label: "snapshot", value: snapshotId }]} className="ml-auto" />
        {duration != null && (
          <span className="font-mono text-2xs text-text-tertiary">
            <span className="uppercase tracking-widest">Duration </span>
            {duration}
          </span>
        )}
      </PanelHeader>
      <PanelBody className="flex flex-col gap-0 p-0">
        {diffsJob.failureReason != null && (
          <div className="flex items-start gap-3 border-b border-status-critical/40 bg-status-critical/5 px-5 py-3">
            <WarningOctagonIcon size={14} className="mt-0.5 shrink-0 text-status-critical" />
            <div className="flex flex-col gap-1">
              <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-status-critical">
                Diffs job failed
              </span>
              <p className="text-xs text-text-secondary">{diffsJob.failureReason}</p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 px-5 py-4">
          {STAGES.map(({ key, title }, index) => (
            <StageChipWithConnector
              key={key}
              title={title}
              status={stageStatuses[key]}
              isActive={expanded === key}
              isLast={index === STAGES.length - 1}
              onClick={() => setExpanded((prev) => (prev === key ? undefined : key))}
            />
          ))}
        </div>

        {expanded != null && (
          <div className="border-t border-border-dim px-5 py-4">
            <StageDetail
              stageKey={expanded}
              diffsJob={diffsJob}
              changes={changes}
              refinementLoop={refinementLoop}
              snapshotId={snapshotId}
            />
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

function StageChipWithConnector({
  title,
  status,
  isActive,
  isLast,
  onClick,
}: {
  title: string;
  status: StageStatus;
  isActive: boolean;
  isLast: boolean;
  onClick: () => void;
}) {
  return (
    <>
      <StageChip title={title} status={status} isActive={isActive} onClick={onClick} />
      {!isLast && <div className="h-px w-3 shrink-0 bg-border-dim" />}
    </>
  );
}

function StageChip({
  title,
  status,
  isActive,
  onClick,
}: {
  title: string;
  status: StageStatus;
  isActive: boolean;
  onClick: () => void;
}) {
  const tone = TONE[status];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={isActive}
      className={cn(
        "inline-flex items-center gap-1.5 border px-2 py-1 text-2xs font-mono uppercase tracking-widest transition-colors",
        tone.frame,
        isActive && "ring-1 ring-primary-ink/40",
      )}
    >
      <StageIcon status={status} />
      <span className={tone.text}>{title}</span>
      <Badge variant={tone.badge} className="px-1 py-0 text-3xs">
        {STATUS_LABEL[status]}
      </Badge>
      <CaretDownIcon size={10} className={cn("text-text-tertiary transition-transform", isActive && "rotate-180")} />
    </button>
  );
}

function StageIcon({ status }: { status: StageStatus }) {
  if (status === "done") return <CheckIcon size={12} weight="bold" className="text-status-passed" />;
  if (status === "current") return <BrailleSpinner animation="scan" size="sm" />;
  if (status === "failed") return <WarningIcon size={12} weight="bold" className="text-status-failed" />;
  return <div className="size-2 rounded-full border border-border-mid" />;
}

const STATUS_LABEL: Record<StageStatus, string> = {
  done: "done",
  current: "running",
  failed: "failed",
  upcoming: "upcoming",
};

const TONE: Record<
  StageStatus,
  { frame: string; text: string; badge: "status-passed" | "status-running" | "status-failed" | "outline" }
> = {
  done: { frame: "border-status-passed/30 bg-status-passed/5", text: "text-text-primary", badge: "status-passed" },
  current: {
    frame: "border-status-running/40 bg-status-running/5",
    text: "text-text-primary",
    badge: "status-running",
  },
  failed: { frame: "border-status-failed/40 bg-status-failed/5", text: "text-text-primary", badge: "status-failed" },
  upcoming: { frame: "border-border-dim bg-surface-base", text: "text-text-tertiary", badge: "outline" },
};

function StageDetail({
  stageKey,
  diffsJob,
  changes,
  refinementLoop,
  snapshotId,
}: {
  stageKey: StageKey;
  diffsJob: DiffsJob;
  changes: SnapshotChange[];
  refinementLoop: RefinementLoop | undefined;
  snapshotId: string;
}) {
  switch (stageKey) {
    case "analysis":
      return <StageAnalysis job={diffsJob} />;
    case "replay":
      return <StageReplay job={diffsJob} />;
    case "resolution":
      return <StageResolution job={diffsJob} />;
    case "generation":
      return <StageGeneration job={diffsJob} refinementLoop={refinementLoop} snapshotId={snapshotId} />;
    case "finalization":
      return <StageFinalization changes={changes} />;
  }
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
