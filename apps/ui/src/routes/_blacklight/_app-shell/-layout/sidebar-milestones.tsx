import {
  Progress,
  ProgressLabel,
  ProgressValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@autonoma/blacklight";
import { FlagPennantIcon } from "@phosphor-icons/react/FlagPennant";
import { Link } from "@tanstack/react-router";
import { Suspense } from "react";
import { useMilestones } from "../app.$appSlug/-home/milestones";

function MilestoneHoverList() {
  const milestones = useMilestones();
  const completed = milestones.filter((m) => m.status === "completed").length;
  const total = milestones.length;

  return (
    <div className="flex w-64 flex-col gap-3 p-1">
      <div className="flex items-center justify-between font-mono text-2xs uppercase tracking-widest text-text-tertiary">
        <span>Milestones</span>
        <span>
          {completed}/{total}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {milestones.map((m) => {
          const isClickable = m.status !== "upcoming";
          const row = (
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "w-5 shrink-0 font-mono text-3xs",
                  m.status === "in_progress" ? "text-primary-ink" : "text-text-tertiary",
                )}
              >
                {String(m.step).padStart(2, "0")}
              </span>
              <span
                className={cn(
                  "flex-1 truncate font-mono text-2xs uppercase tracking-wider",
                  m.status === "completed" && "text-text-tertiary line-through decoration-text-tertiary/50",
                  m.status === "in_progress" && "text-text-primary",
                  m.status === "upcoming" && "text-text-tertiary",
                )}
              >
                {m.label}
              </span>
              <span
                className={cn(
                  "font-mono text-3xs uppercase tracking-wider",
                  m.status === "completed" && "text-text-tertiary",
                  m.status === "in_progress" && "text-primary-ink",
                  m.status === "upcoming" && "text-text-tertiary",
                )}
              >
                {m.status === "completed" ? "Done" : m.status === "in_progress" ? "Now" : "Next"}
              </span>
            </span>
          );

          return (
            <li key={m.id}>
              {isClickable ? (
                <Link
                  to={m.href}
                  className="block border border-transparent px-1.5 py-1.5 hover:border-border-dim hover:bg-surface-raised"
                >
                  {row}
                </Link>
              ) : (
                <span className="block px-1.5 py-1.5">{row}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SidebarMilestonesContent({ collapsed }: { collapsed: boolean }) {
  const milestones = useMilestones();

  const completed = milestones.filter((m) => m.status === "completed").length;
  const total = milestones.length;

  if (completed === total) return null;

  const percentage = Math.round((completed / total) * 100);

  if (collapsed) {
    return (
      <div className="flex justify-center px-2 py-2">
        <Tooltip>
          <TooltipTrigger render={<div className="relative cursor-pointer" />}>
            <FlagPennantIcon size={18} className="text-primary-ink" />
            <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center bg-primary-ink font-mono text-[8px] font-bold leading-none text-background">
              {completed}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" align="start" className="max-w-none p-2">
            <MilestoneHoverList />
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<div className="block cursor-pointer px-4 py-3 hover:bg-surface-raised" />}>
        <Progress value={percentage} className="[&_[data-slot=progress-indicator]]:bg-primary-ink">
          <ProgressLabel>Milestones</ProgressLabel>
          <ProgressValue>{() => `${completed}/${total}`}</ProgressValue>
        </Progress>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-none p-2">
        <MilestoneHoverList />
      </TooltipContent>
    </Tooltip>
  );
}

export function SidebarMilestones({ collapsed }: { collapsed: boolean }) {
  return (
    <Suspense>
      <SidebarMilestonesContent collapsed={collapsed} />
    </Suspense>
  );
}
