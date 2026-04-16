import { Tooltip, TooltipContent, TooltipTrigger, cn } from "@autonoma/blacklight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { trpc } from "lib/trpc";
import { Fragment } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

type MilestoneStatus = "completed" | "in_progress" | "upcoming";

interface Milestone {
  id: string;
  step: number;
  label: string;
  tooltip: string;
  status: MilestoneStatus;
  href: string;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

const DEFINITIONS = [
  {
    id: "install_agent",
    label: "INSTALL AGENT",
    tooltip: "Install the Autonoma agent in your application",
  },
  {
    id: "configure_tests",
    label: "CONFIGURE TESTS",
    tooltip: "Configure your initial test scenarios",
  },
  {
    id: "ci",
    label: "SET UP CI",
    tooltip: "Connect your GitHub repository to trigger tests on deployments",
  },
  {
    id: "first_run",
    label: "FIRST RUN",
    tooltip: "Execute your first test run against your application",
  },
  {
    id: "first_bug",
    label: "FIRST BUG FIX",
    tooltip: "Find and resolve your first bug detected by Autonoma",
  },
] as const;

export function useMilestones(applicationId: string, appSlug: string): Milestone[] | undefined {
  const base = `/app/${appSlug}`;

  const { data: runs } = useQuery(trpc.runs.list.queryOptions({ applicationId }));
  const { data: bugs } = useQuery(trpc.bugs.list.queryOptions({ applicationId }));
  const { data: installation } = useQuery(trpc.github.getInstallations.queryOptions());

  if (runs == null || bugs == null) return undefined;

  const completionMap: Record<string, boolean> = {
    install_agent: true,
    configure_tests: true,
    ci: installation != null,
    first_run: runs.length > 0,
    first_bug: bugs.some((b) => b.status === "resolved"),
  };

  const hrefMap: Record<string, string> = {
    install_agent: base,
    configure_tests: base,
    ci: `${base}/settings`,
    first_run: `${base}/runs`,
    first_bug: `${base}/bugs`,
  };

  const firstIncompleteIndex = DEFINITIONS.findIndex((d) => !completionMap[d.id]);

  return DEFINITIONS.map((def, index) => ({
    ...def,
    step: index + 1,
    href: hrefMap[def.id]!,
    status: completionMap[def.id]! ? "completed" : index === firstIncompleteIndex ? "in_progress" : "upcoming",
  }));
}

// ─── Corner decorations ──────────────────────────────────────────────────────

function MilestoneCorners() {
  const base = "absolute size-2 pointer-events-none z-20 border-primary-ink/30";
  return (
    <>
      <div className={`${base} top-0 left-0 border-t border-l`} />
      <div className={`${base} top-0 right-0 border-t border-r`} />
      <div className={`${base} bottom-0 left-0 border-b border-l`} />
      <div className={`${base} bottom-0 right-0 border-b border-r`} />
    </>
  );
}

// ─── Step indicator ──────────────────────────────────────────────────────────

function StepIndicator({ milestone }: { milestone: Milestone }) {
  return (
    <div
      className={cn(
        "flex size-8 items-center justify-center border transition-colors",
        milestone.status === "completed" && "border-primary bg-primary",
        milestone.status === "in_progress" && "border-primary-ink bg-transparent",
        milestone.status === "upcoming" && "border-border-mid bg-transparent",
      )}
    >
      {milestone.status === "completed" ? (
        <CheckIcon size={16} weight="bold" className="text-primary-foreground" />
      ) : (
        <span
          className={cn(
            "font-mono text-2xs font-bold",
            milestone.status === "in_progress" ? "text-primary-ink" : "text-text-tertiary",
          )}
        >
          {String(milestone.step).padStart(2, "0")}
        </span>
      )}
    </div>
  );
}

// ─── Connector line ──────────────────────────────────────────────────────────

function Connector({ from, to }: { from: MilestoneStatus; to: MilestoneStatus }) {
  const bothCompleted = from === "completed" && to === "completed";
  const transitioning = from === "completed" && to !== "completed";

  return (
    <div
      className={cn(
        "mx-2 h-0.5 flex-1",
        bothCompleted && "bg-primary-ink",
        transitioning && "bg-gradient-to-r from-primary-ink to-border-dim",
        !bothCompleted && !transitioning && "bg-border-dim",
      )}
    />
  );
}

// ─── Status label ────────────────────────────────────────────────────────────

function StatusLabel({ status }: { status: MilestoneStatus }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center border px-2 font-mono text-3xs font-bold uppercase tracking-wider",
        status === "completed" && "border-primary/40 bg-primary text-primary-foreground",
        status === "in_progress" && "border-primary-ink/40 text-primary-ink",
        status === "upcoming" && "border-border-mid text-text-tertiary",
      )}
    >
      {status === "completed" ? "Done" : status === "in_progress" ? "Current" : "Upcoming"}
    </span>
  );
}

// ─── Single milestone step ───────────────────────────────────────────────────

function MilestoneStep({ milestone }: { milestone: Milestone }) {
  const isClickable = milestone.status !== "upcoming";

  const content = (
    <div className="flex flex-col items-center">
      <StepIndicator milestone={milestone} />

      <div className="mt-3 flex flex-col items-center gap-1.5">
        <span
          className={cn(
            "font-mono text-2xs font-bold tracking-wider",
            milestone.status === "completed" && "text-primary-ink",
            milestone.status === "in_progress" && "text-text-primary",
            milestone.status === "upcoming" && "text-text-tertiary",
          )}
        >
          {milestone.label}
        </span>

        <StatusLabel status={milestone.status} />
      </div>
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          isClickable ? <Link to={milestone.href} className="shrink-0 cursor-pointer" /> : <div className="shrink-0" />
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipContent side="bottom">{milestone.tooltip}</TooltipContent>
    </Tooltip>
  );
}

// ─── Full component ──────────────────────────────────────────────────────────

export function Milestones({ applicationId, appSlug }: { applicationId: string; appSlug: string }) {
  const milestones = useMilestones(applicationId, appSlug);

  if (milestones == null) return <MilestonesSkeleton />;

  const allComplete = milestones.every((m) => m.status === "completed");
  if (allComplete) return null;

  return (
    <div className="relative border border-primary-ink/20 bg-primary-ink/5">
      <MilestoneCorners />

      {/* Header */}
      <div className="flex items-center border-b border-primary-ink/15 px-5 py-3">
        <div className="flex items-center gap-2 font-mono text-2xs font-bold uppercase tracking-wider text-text-primary">
          <span className="inline-block size-1.5 bg-primary" />
          Milestones
        </div>
      </div>

      {/* Body */}
      <div className="px-8 py-6">
        <div className="flex items-start">
          {milestones.map((milestone, index) => (
            <Fragment key={milestone.id}>
              <MilestoneStep milestone={milestone} />
              {index < milestones.length - 1 && (
                <Connector from={milestone.status} to={milestones[index + 1]!.status} />
              )}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

export function MilestonesSkeleton() {
  return (
    <div className="relative border border-primary-ink/20 bg-primary-ink/5">
      <MilestoneCorners />

      <div className="flex items-center border-b border-primary-ink/15 px-5 py-3">
        <div className="flex items-center gap-2 font-mono text-2xs font-bold uppercase tracking-wider text-text-primary">
          <span className="inline-block size-1.5 bg-primary" />
          Milestones
        </div>
      </div>

      <div className="px-8 py-6">
        <div className="flex items-start">
          {[1, 2, 3, 4, 5].map((i) => (
            <Fragment key={i}>
              <div className="flex flex-col items-center">
                <div className="size-8 animate-pulse bg-surface-raised" />
                <div className="mt-3 flex flex-col items-center gap-1.5">
                  <div className="h-3.5 w-20 animate-pulse bg-surface-raised" />
                  <div className="h-5 w-16 animate-pulse bg-surface-raised" />
                </div>
              </div>
              {i < 5 && <div className="mx-2 mt-4 h-0.5 flex-1 bg-border-dim" />}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
