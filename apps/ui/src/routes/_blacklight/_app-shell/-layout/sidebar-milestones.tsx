import { Progress, ProgressLabel, ProgressValue, Tooltip, TooltipContent, TooltipTrigger } from "@autonoma/blacklight";
import { FlagPennantIcon } from "@phosphor-icons/react/FlagPennant";
import { useParams, useRouteContext } from "@tanstack/react-router";
import { useMilestones } from "../app.$appSlug/-home/milestones";

function SidebarMilestonesContent({
  applicationId,
  appSlug,
  collapsed,
}: {
  applicationId: string;
  appSlug: string;
  collapsed: boolean;
}) {
  const milestones = useMilestones(applicationId, appSlug);

  if (milestones == null) return null;

  const completed = milestones.filter((m) => m.status === "completed").length;
  const total = milestones.length;

  if (completed === total) return null;

  const percentage = Math.round((completed / total) * 100);

  if (collapsed) {
    return (
      <div className="flex justify-center px-2 py-2">
        <Tooltip>
          <TooltipTrigger render={<div className="relative" />}>
            <FlagPennantIcon size={18} className="text-primary-ink" />
            <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center bg-primary-ink font-mono text-[8px] font-bold leading-none text-background">
              {completed}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">
            {completed}/{total} milestones
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <Progress value={percentage} className="[&_[data-slot=progress-indicator]]:bg-primary-ink">
        <ProgressLabel>Milestones</ProgressLabel>
        <ProgressValue>{() => `${completed}/${total}`}</ProgressValue>
      </Progress>
    </div>
  );
}

export function SidebarMilestones({ collapsed }: { collapsed: boolean }) {
  const applications = useRouteContext({ from: "/_blacklight/_app-shell", select: (ctx) => ctx.applications });
  const params = useParams({ strict: false }) as { appSlug?: string };

  if (params.appSlug == null) return null;

  const app = applications.find((a) => a.slug === params.appSlug);
  if (app == null) return null;

  return <SidebarMilestonesContent applicationId={app.id} appSlug={params.appSlug} collapsed={collapsed} />;
}
