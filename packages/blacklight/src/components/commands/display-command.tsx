import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { Cursor } from "@phosphor-icons/react/Cursor";
import { CursorClick } from "@phosphor-icons/react/CursorClick";
import { Globe } from "@phosphor-icons/react/Globe";
import { Keyboard } from "@phosphor-icons/react/Keyboard";
import { Mouse } from "@phosphor-icons/react/Mouse";
import { Question } from "@phosphor-icons/react/Question";
import { cn } from "../../lib/utils";
import { commandColors } from "./command-colors";
import type { CommandUI } from "./command-ui";

const clickUI: CommandUI = {
  name: "click",
  instruction: (params) => (
    <>
      Click on <strong>{params.description as string}</strong>
    </>
  ),
  iconComponent: CursorClick,
  color: commandColors.interact,
  badgeClassName: "bg-blue-50 text-blue-700 border-blue-200",
};

const dragUI: CommandUI = {
  name: "drag",
  instruction: (params) => (
    <>
      Drag from <strong>{params.startDescription as string}</strong> to{" "}
      <strong>{params.endDescription as string}</strong>
    </>
  ),
  iconComponent: CursorClick,
  color: commandColors.interact,
  badgeClassName: "bg-blue-50 text-blue-700 border-blue-200",
};

const typeUI: CommandUI = {
  name: "type",
  instruction: (params) => (
    <>
      Type <strong>{params.text as string}</strong> into <strong>{params.description as string}</strong>
    </>
  ),
  iconComponent: Keyboard,
  color: commandColors.interact,
  badgeClassName: "bg-violet-50 text-violet-700 border-violet-200",
};

const scrollUI: CommandUI = {
  name: "scroll",
  instruction: (params) => (
    <>
      Scroll <strong>{params.direction as string}</strong>{" "}
      {params.elementDescription != null && (
        <>
          on <strong>{params.elementDescription as string}</strong>{" "}
        </>
      )}
      {params.condition != null && (
        <>
          until <strong>{params.condition as string}</strong>
        </>
      )}
    </>
  ),
  iconComponent: Mouse,
  color: commandColors.interact,
  badgeClassName: "bg-sky-50 text-sky-700 border-sky-200",
};

const assertUI: CommandUI = {
  name: "assert",
  instruction: (params) => (
    <>
      Assert that <strong>{params.instruction as string}</strong>
    </>
  ),
  iconComponent: CheckCircle,
  color: commandColors.assert,
  badgeClassName: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

const refreshUI: CommandUI = {
  name: "refresh",
  instruction: () => <>Refresh the browser page</>,
  iconComponent: ArrowClockwise,
  color: commandColors.navigate,
  badgeClassName: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

const navigateUI: CommandUI = {
  name: "navigate",
  instruction: (params) => (
    <>
      Navigate to <strong>{params.url as string}</strong>
    </>
  ),
  iconComponent: Globe,
  color: commandColors.navigate,
  badgeClassName: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

const hoverUI: CommandUI = {
  name: "hover",
  instruction: (params) => (
    <>
      Hover over <strong>{params.description as string}</strong>
    </>
  ),
  iconComponent: Cursor,
  color: commandColors.interact,
  badgeClassName: "bg-blue-50 text-blue-700 border-blue-200",
};

const displayCommand: Record<string, CommandUI> = {
  click: clickUI,
  drag: dragUI,
  type: typeUI,
  scroll: scrollUI,
  assert: assertUI,
  refresh: refreshUI,
  navigate: navigateUI,
  hover: hoverUI,
};

const unknownCommandUI: CommandUI = {
  name: "Unknown",
  instruction: () => "Unknown",
  iconComponent: Question,
  color: commandColors.unknown,
  badgeClassName: "bg-surface-wash text-ink-500 border-edge",
};

export function getUI(interaction: string): CommandUI {
  return displayCommand[interaction] ?? unknownCommandUI;
}

export function stepInstruction(step: { interaction: string; params: unknown }): React.ReactNode {
  return getUI(step.interaction).instruction((step.params ?? {}) as Record<string, unknown>);
}

export interface StepIconProps {
  interaction: string;
  className?: string;
}

export function StepIcon({ interaction, className }: StepIconProps) {
  const { iconComponent: Icon, color } = getUI(interaction);
  return <Icon className={cn(color, className)} />;
}
