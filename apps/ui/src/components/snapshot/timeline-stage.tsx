import { Badge, BrailleSpinner } from "@autonoma/blacklight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import type { ReactNode } from "react";
import type { StageStatus } from "./diffs-timeline-types";

interface TimelineStageProps {
  index: number;
  title: string;
  status: StageStatus;
  isLast?: boolean;
  children: ReactNode;
}

export function TimelineStage({ index, title, status, isLast, children }: TimelineStageProps) {
  return (
    <div className="relative flex gap-4">
      <div className="flex flex-col items-center">
        <StageMarker status={status} index={index} />
        {!(isLast ?? false) && (
          <div
            className={status === "done" ? "mt-1 w-px flex-1 bg-status-passed/40" : "mt-1 w-px flex-1 bg-border-dim"}
          />
        )}
      </div>
      <div className="flex-1 pb-8">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-base font-medium tracking-tight text-text-primary">{title}</h2>
          <StatusBadge status={status} />
        </div>
        <div className={status === "upcoming" ? "opacity-50" : undefined}>{children}</div>
      </div>
    </div>
  );
}

function StageMarker({ status, index }: { status: StageStatus; index: number }) {
  if (status === "done") {
    return (
      <div className="flex size-7 items-center justify-center rounded-full bg-status-passed/20 text-status-passed">
        <CheckIcon size={14} weight="bold" />
      </div>
    );
  }

  if (status === "current") {
    return (
      <div className="flex size-7 items-center justify-center rounded-full bg-status-running/20 text-status-running">
        <BrailleSpinner animation="scan" size="sm" />
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="flex size-7 items-center justify-center rounded-full bg-status-failed/20 text-status-failed">
        <WarningIcon size={14} weight="bold" />
      </div>
    );
  }

  return (
    <div className="flex size-7 items-center justify-center rounded-full border border-border-mid bg-surface-base text-text-tertiary">
      <span className="font-mono text-2xs">{index + 1}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: StageStatus }) {
  switch (status) {
    case "done":
      return (
        <Badge variant="status-passed" className="px-1.5 py-0 text-3xs">
          done
        </Badge>
      );
    case "current":
      return (
        <Badge variant="status-running" className="px-1.5 py-0 text-3xs">
          in progress
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="status-failed" className="px-1.5 py-0 text-3xs">
          failed
        </Badge>
      );
    case "upcoming":
      return (
        <Badge variant="outline" className="px-1.5 py-0 text-3xs">
          upcoming
        </Badge>
      );
  }
}
