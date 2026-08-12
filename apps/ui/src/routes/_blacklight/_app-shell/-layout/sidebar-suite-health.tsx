import { Skeleton, Tooltip, TooltipContent, TooltipTrigger, cn } from "@autonoma/blacklight";
import type { SuiteHealth, SuiteHealthLevel } from "@autonoma/types";
import { SUITE_HEALTH_LEVELS, suiteHealthRank } from "@autonoma/types";
import { WrenchIcon } from "@phosphor-icons/react/Wrench";
import { useShellSuiteHealth } from "lib/query/app-shell.queries";
import { Component, Suspense, useState, type ReactNode } from "react";
import {
  SUITE_HEALTH_LOWERS,
  SUITE_HEALTH_PRESENTATION,
  SUITE_HEALTH_RAISES,
  suiteHealthDriverNote,
  suiteHealthFooter,
  suiteHealthStats,
} from "./suite-health-copy";
import { SuiteHealthFixDialog } from "./suite-health-fix-dialog";

/** Where "how it works" goes: the public docs page explaining the calculation, not an in-app tab. */
const SUITE_HEALTH_DOCS_URL = "https://docs.autonoma.app/suite-health";

/** Rising bar heights, one per rung of the ladder. Index maps to rank, so the array length is the ladder's. */
const BAR_HEIGHTS = ["h-1.5", "h-2", "h-3", "h-4", "h-5"];

/**
 * Below this rung the suite has a backlog worth handing to an agent, so the tooltip offers to. At CALIBRATING and
 * above there is nothing to fix - the suite is converging on its own, and offering a repair would say otherwise.
 */
const FIX_OFFERED_BELOW_RANK = suiteHealthRank("calibrating");

function isFixOffered(level: SuiteHealthLevel): boolean {
  return suiteHealthRank(level) < FIX_OFFERED_BELOW_RANK;
}

function SuiteHealthBars({ health }: { health: SuiteHealth }) {
  const { bar } = SUITE_HEALTH_PRESENTATION[health.level];

  return (
    <div className="flex h-5 items-end gap-1">
      {SUITE_HEALTH_LEVELS.map((level, index) => (
        <span
          key={level}
          className={cn("w-1.5 shrink-0", BAR_HEIGHTS[index], index < health.rank ? bar : "bg-border-dim")}
        />
      ))}
    </div>
  );
}

function SuiteHealthPill({ health }: { health: SuiteHealth }) {
  const { label, pill } = SUITE_HEALTH_PRESENTATION[health.level];

  return (
    <span className={cn("border px-1.5 py-0.5 font-mono text-4xs font-semibold uppercase tracking-widest", pill)}>
      {label}
    </span>
  );
}

/** Exported so a story can render the panel on its own - it needs no router context at all. */
export function SuiteHealthTooltip({ health, onFixIt }: { health: SuiteHealth; onFixIt?: () => void }) {
  const { label, body, dot } = SUITE_HEALTH_PRESENTATION[health.level];
  const driverNote = suiteHealthDriverNote(health.driver);

  return (
    <div className="flex w-80 flex-col">
      <div className="flex items-center gap-2 border-b border-border-dim px-3.5 py-2.5">
        <span className={cn("size-1.5 shrink-0", dot)} />
        <span className="font-mono text-3xs font-semibold uppercase tracking-widest text-text-primary">
          Suite health · {label}
        </span>
        <span className="flex-1" />
        {onFixIt != null && isFixOffered(health.level) && (
          <button
            type="button"
            onClick={onFixIt}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 bg-primary px-2 py-1 font-mono text-4xs font-bold uppercase tracking-widest text-background hover:bg-primary-ink"
          >
            <WrenchIcon size={11} weight="fill" />
            Fix it
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2 border-b border-border-dim px-3.5 py-3">
        <p className="text-pretty text-xs leading-relaxed text-text-primary">{body}</p>
        {driverNote != null && <p className="text-pretty text-xs leading-relaxed text-text-secondary">{driverNote}</p>}
      </div>

      <div className="flex flex-col gap-3 px-3.5 py-3">
        <SuiteHealthFactorList title="Raises it" sign="+" tone="text-status-success" items={SUITE_HEALTH_RAISES} />
        <SuiteHealthFactorList title="Lowers it" sign="−" tone="text-status-critical" items={SUITE_HEALTH_LOWERS} />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border-dim bg-surface-base px-3.5 py-2.5">
        <span className="font-mono text-4xs uppercase tracking-wider text-text-secondary">
          {suiteHealthFooter(health)}
        </span>
        <a
          href={SUITE_HEALTH_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 font-mono text-3xs text-primary-ink hover:underline"
        >
          how it works →
        </a>
      </div>
    </div>
  );
}

function SuiteHealthFactorList({
  title,
  sign,
  tone,
  items,
}: {
  title: string;
  sign: string;
  tone: string;
  items: string[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">{title}</span>
      {items.map((item) => (
        <div key={item} className="flex items-baseline gap-2">
          <span className={cn("w-2 shrink-0 font-mono text-2xs", tone)}>{sign}</span>
          <span className="text-xs leading-snug text-text-secondary">{item}</span>
        </div>
      ))}
    </div>
  );
}

function SidebarSuiteHealthContent({ collapsed }: { collapsed: boolean }) {
  const { data: health } = useShellSuiteHealth();
  const [fixOpen, setFixOpen] = useState(false);
  // The tooltip is controlled so opening the modal can dismiss it. Left uncontrolled it stays open behind the
  // backdrop until the pointer happens to move, which reads as two overlapping panels.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const openFix = () => {
    setFixOpen(true);
    setTooltipOpen(false);
  };
  const fixDialog = <SuiteHealthFixDialog health={health} open={fixOpen} onOpenChange={setFixOpen} />;

  if (collapsed) {
    return (
      <>
        <div className="flex justify-center px-2 py-3">
          <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
            <TooltipTrigger render={<div className="cursor-default" />}>
              <SuiteHealthBars health={health} />
            </TooltipTrigger>
            <TooltipContent side="right" align="start" className="max-w-none p-0">
              <SuiteHealthTooltip health={health} onFixIt={openFix} />
            </TooltipContent>
          </Tooltip>
        </div>
        {fixDialog}
      </>
    );
  }

  return (
    <>
      <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger
          render={<div className="flex cursor-default flex-col gap-2 px-4 py-3 hover:bg-surface-raised" />}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">
              Suite health
            </span>
            <SuiteHealthPill health={health} />
          </div>
          <div className="flex items-end gap-2">
            <SuiteHealthBars health={health} />
            <span className="flex-1" />
            <span className="font-mono text-3xs text-text-secondary">{health.rank}/5</span>
          </div>
          <span className="truncate font-mono text-3xs text-text-secondary">{suiteHealthStats(health)}</span>
        </TooltipTrigger>
        <TooltipContent side="right" align="start" className="max-w-none p-0">
          <SuiteHealthTooltip health={health} onFixIt={openFix} />
        </TooltipContent>
      </Tooltip>
      {fixDialog}
    </>
  );
}

function SidebarSuiteHealthSkeleton({ collapsed }: { collapsed: boolean }) {
  if (collapsed) {
    return (
      <div className="flex justify-center px-2 py-3">
        <Skeleton className="h-5 w-10" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-16" />
      </div>
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-3 w-32" />
    </div>
  );
}

/**
 * Isolates a failed suite-health fetch to the meter itself, and renders nothing when it happens.
 *
 * The sidebar is on every page, so without this the throw from `useSuspenseQuery` - including one from the
 * background poll, which re-throws on the next render - takes the whole app shell down with it. There is nothing
 * useful to say in its place either: the meter is a passive glance at a number, and an error row where a number
 * belongs asks the reader to deal with a problem that is not theirs. It comes back on its own on the next poll.
 */
class SuiteHealthErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  override state: { hasError: boolean } = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    return this.state.hasError ? null : this.props.children;
  }
}

export function SidebarSuiteHealth({ collapsed }: { collapsed: boolean }) {
  return (
    <SuiteHealthErrorBoundary>
      <Suspense fallback={<SidebarSuiteHealthSkeleton collapsed={collapsed} />}>
        <SidebarSuiteHealthContent collapsed={collapsed} />
      </Suspense>
    </SuiteHealthErrorBoundary>
  );
}
