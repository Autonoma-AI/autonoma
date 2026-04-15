import {
  AGENT_INDICATOR_STATE_LABEL,
  BrailleSpinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  type AgentIndicatorState,
} from "@autonoma/blacklight";
import type { BrailleSpinnerAnimation } from "@autonoma/blacklight";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { Link } from "@tanstack/react-router";
import { type ActivityLine, useBranchActivity } from "./use-branch-activity";

const STATE_ANIMATION: Record<AgentIndicatorState, BrailleSpinnerAnimation> = {
  idle: "breathe",
  processing: "braillewave",
  analyzing: "scan",
  working: "helix",
  success: "orbit",
  failed: "braille",
};

// ─── Components ──────────────────────────────────────────────────────────────

function ActivityLineItem({ activity }: { activity: ActivityLine }) {
  const content = (
    <div className="flex items-center gap-2 py-0.5">
      <CircleIcon size={6} weight="fill" className={`shrink-0 ${activity.colorClass}`} />
      <span className="truncate font-mono text-3xs text-text-secondary">{activity.label}</span>
    </div>
  );

  if (activity.href != null) {
    return (
      <Link to={activity.href} className="block transition-opacity hover:opacity-80">
        {content}
      </Link>
    );
  }

  return content;
}

export function SidebarAgentStatus({ collapsed }: { collapsed: boolean }) {
  const { state, activities } = useBranchActivity();

  const inner = (
    <div
      className={`flex border-b border-border-dim transition-colors ${
        collapsed ? "flex-col items-center px-2 py-3" : "flex-col gap-2 px-4 py-3"
      }`}
    >
      <div className={`flex items-center ${collapsed ? "justify-center" : "gap-3.5"}`}>
        <BrailleSpinner animation={STATE_ANIMATION[state]} size="sm" className="text-primary-ink" />
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="text-2xs font-medium text-text-secondary">Autonoma Agent</p>
            <p className="font-mono text-3xs text-text-tertiary">{AGENT_INDICATOR_STATE_LABEL[state]}</p>
          </div>
        )}
      </div>

      {!collapsed && activities.length > 0 && (
        <div className="flex flex-col gap-0.5 pl-[30px]">
          {activities.map((activity) => (
            <ActivityLineItem key={activity.type} activity={activity} />
          ))}
        </div>
      )}
    </div>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger render={<div />}>{inner}</TooltipTrigger>
        <TooltipContent side="right">
          <div className="flex flex-col gap-1">
            <div>
              <span className="font-medium">Autonoma Agent</span>
              <span className="ml-1.5 text-text-tertiary">{AGENT_INDICATOR_STATE_LABEL[state]}</span>
            </div>
            {activities.map((activity) => (
              <div key={activity.type} className="flex items-center gap-1.5">
                <CircleIcon size={6} weight="fill" className={activity.colorClass} />
                <span className="text-3xs">{activity.label}</span>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return inner;
}
