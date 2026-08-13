import { Skeleton, Tooltip, TooltipContent, TooltipTrigger, cn } from "@autonoma/blacklight";
import type { SuiteHealth, SuiteHealthLevel } from "@autonoma/types";
import { suiteHealthRank } from "@autonoma/types";
import { WrenchIcon } from "@phosphor-icons/react/Wrench";
import { IsolatedErrorBoundary } from "components/isolated-error-boundary";
import { SuiteHealthBars, SuiteHealthPill } from "components/suite-health/suite-health-meter";
import { useShellSuiteHealth } from "lib/query/app-shell.queries";
import {
  SUITE_HEALTH_LOWERS,
  SUITE_HEALTH_PRESENTATION,
  SUITE_HEALTH_RAISES,
  suiteHealthDriverNote,
  suiteHealthFooter,
  suiteHealthStats,
} from "lib/suite-health/copy";
import { Suspense, useState } from "react";
import { SuiteHealthFixDialog } from "./suite-health-fix-dialog";

/** Where "how it works" goes: the public docs page explaining the calculation, not an in-app tab. */
const SUITE_HEALTH_DOCS_URL = "https://docs.autonoma.app/suite-health";

/**
 * Below this rung the suite has a backlog worth handing to an agent, so the tooltip offers to. At CALIBRATING and
 * above there is nothing to fix - the suite is converging on its own, and offering a repair would say otherwise.
 */
const FIX_OFFERED_BELOW_RANK = suiteHealthRank("calibrating");

function isFixOffered(level: SuiteHealthLevel): boolean {
  return suiteHealthRank(level) < FIX_OFFERED_BELOW_RANK;
}

/** Exported so a story can render the panel on its own - it needs no router context at all. */
export function SuiteHealthTooltip({ health, onFixIt }: { health: SuiteHealth; onFixIt?: () => void }) {
  const { label, body, dot } = SUITE_HEALTH_PRESENTATION[health.level];
  const driverNote = suiteHealthDriverNote(health.driver);

  return (
    <div className="flex w-80 flex-col">
      {/* The rank and the stats line lived beside the meter while it had a 200px column to itself. The bar has
          no room for either, so they moved in here rather than being dropped. */}
      <div className="flex items-center gap-2 border-b border-border-dim px-3.5 py-2.5">
        <span className={cn("size-1.5 shrink-0", dot)} />
        <span className="font-mono text-3xs font-semibold uppercase tracking-widest text-text-primary">
          Suite health · {label} · {health.rank}/5
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
        <span className="font-mono text-3xs text-text-secondary">{suiteHealthStats(health)}</span>
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

function SuiteHealthCardContent() {
  const { data: health } = useShellSuiteHealth();
  const [fixOpen, setFixOpen] = useState(false);
  // The tooltip is controlled so opening the modal can dismiss it. Left uncontrolled it stays open behind the
  // backdrop until the pointer happens to move, which reads as two overlapping panels.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const openFix = () => {
    setFixOpen(true);
    setTooltipOpen(false);
  };

  return (
    <>
      <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger
          render={
            <div
              aria-label="Suite health"
              className="flex cursor-default items-center gap-5 border border-border-dim bg-surface-base px-4 py-2.5 transition-colors hover:border-border-mid"
            />
          }
        >
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-3xs font-semibold uppercase tracking-widest text-text-secondary">
                Suite health
              </span>
              <SuiteHealthPill health={health} />
            </div>
            {/* The rank and the stats read here rather than only in the panel: with a page to sit on, the two
                numbers a reader wants at a glance no longer have to be hovered for. */}
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-2xl font-medium leading-none text-text-primary">{health.rank}/5</span>
              <span className="font-mono text-2xs text-text-secondary">{suiteHealthStats(health)}</span>
            </div>
          </div>
          <SuiteHealthBars health={health} />
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="max-w-none p-0">
          <SuiteHealthTooltip health={health} onFixIt={openFix} />
        </TooltipContent>
      </Tooltip>
      <SuiteHealthFixDialog health={health} open={fixOpen} onOpenChange={setFixOpen} />
    </>
  );
}

function SuiteHealthCardSkeleton() {
  return <Skeleton className="h-16 w-72" />;
}

/**
 * How the suite is doing, on the page it is about rather than in the chrome.
 *
 * It sat in the top bar, where there was room for bars and a word and nothing else - so the rank and the
 * stats line could only be reached by hovering. On the application's own heading it has room to say both
 * outright, and it stops being a permanent fixture on every screen for something that is only ever a fact
 * about one application.
 */
export function SuiteHealthCard() {
  // No fallback: a failed poll is a passive glance at a number that comes back on its own next tick, and an
  // error card beside the page heading would outlive its own cause.
  return (
    <IsolatedErrorBoundary>
      <Suspense fallback={<SuiteHealthCardSkeleton />}>
        <SuiteHealthCardContent />
      </Suspense>
    </IsolatedErrorBoundary>
  );
}
