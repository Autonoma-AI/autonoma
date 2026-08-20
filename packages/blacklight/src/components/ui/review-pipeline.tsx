"use client";

import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { BrowsersIcon } from "@phosphor-icons/react/Browsers";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { DatabaseIcon } from "@phosphor-icons/react/Database";
import { EyeIcon } from "@phosphor-icons/react/Eye";
import { FlaskIcon } from "@phosphor-icons/react/Flask";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

const REVIEW_PIPELINE_STAGES = ["pull_request", "preview", "test_data", "run", "review"] as const;

export type ReviewPipelineStage = (typeof REVIEW_PIPELINE_STAGES)[number];

interface StageMeta {
  label: string;
  icon: ReactNode;
}

/** Two or three words each. Anything longer and the rail wraps on a narrow panel. */
const STAGE_META: Record<ReviewPipelineStage, StageMeta> = {
  pull_request: { label: "Pull request", icon: <GitPullRequestIcon size={12} weight="fill" /> },
  preview: { label: "Preview", icon: <BrowsersIcon size={12} /> },
  test_data: { label: "Test data", icon: <DatabaseIcon size={12} /> },
  run: { label: "Run", icon: <FlaskIcon size={12} /> },
  review: { label: "Review", icon: <EyeIcon size={12} weight="fill" /> },
};

export interface ReviewPipelineProps {
  /**
   * Where the run has got to. Omitted entirely, every stage renders dim and idle - the waiting case, rather than
   * a rail pretending to be at stage one.
   */
  activeStage?: ReviewPipelineStage;
  className?: string;
}

/** Deliberately not navigable: it reports position, and none of these stages is a place the user can go. */
export function ReviewPipeline({ activeStage, className }: ReviewPipelineProps) {
  const activeIndex = activeStage != null ? REVIEW_PIPELINE_STAGES.indexOf(activeStage) : -1;

  return (
    <ol className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {REVIEW_PIPELINE_STAGES.map((stage, index) => {
        const isActive = index === activeIndex;
        const isDone = activeIndex >= 0 && index < activeIndex;
        const { label, icon } = STAGE_META[stage];

        return (
          <li key={stage} className="flex items-center gap-1.5">
            {index > 0 && (
              <ArrowRightIcon
                size={10}
                weight="bold"
                className={cn("shrink-0", isDone || isActive ? "text-primary-ink/40" : "text-border-mid")}
              />
            )}
            <span
              className={cn(
                "flex items-center gap-1.5 border px-2 py-1 font-mono text-3xs uppercase tracking-widest transition-colors",
                isActive && "border-primary-ink/30 bg-primary-ink/10 text-primary-ink",
                isDone && "border-transparent text-text-secondary",
                // Dim rather than absent: the reader still needs to see the stage exists, which is the whole
                // point on the waiting screen where nothing is lit at all.
                !isActive && !isDone && "border-transparent text-text-secondary opacity-50",
              )}
            >
              <StageMarker isActive={isActive} isDone={isDone} icon={icon} />
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StageMarker({ isActive, isDone, icon }: { isActive: boolean; isDone: boolean; icon: ReactNode }) {
  if (isDone) return <CheckIcon size={10} weight="bold" className="text-primary-ink" />;
  if (isActive) {
    return <span className="size-1.5 animate-pulse bg-primary-ink shadow-[0_0_8px_var(--accent-glow)]" />;
  }
  return <span className="shrink-0">{icon}</span>;
}
