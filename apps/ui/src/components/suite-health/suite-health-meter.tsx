import { cn } from "@autonoma/blacklight";
import type { SuiteHealth } from "@autonoma/types";
import { SUITE_HEALTH_LEVELS } from "@autonoma/types";
import { SUITE_HEALTH_PRESENTATION } from "lib/suite-health/copy";

/** Rising bar heights, one per rung of the ladder. Index maps to rank, so the array length is the ladder's. */
const BAR_HEIGHTS = ["h-1.5", "h-2", "h-3", "h-4", "h-5"];

/**
 * The five-rung meter. Lit bars up to the suite's rank, in the level's own colour.
 *
 * Shared rather than owned by the sidebar: the same meter appears at the end of
 * onboarding, where it is the first thing that explains why a brand-new suite is
 * not green yet, and two drawings of one measurement would drift apart.
 */
export function SuiteHealthBars({ health }: { health: SuiteHealth }) {
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

export function SuiteHealthPill({ health }: { health: SuiteHealth }) {
  const { label, pill } = SUITE_HEALTH_PRESENTATION[health.level];

  return (
    <span className={cn("border px-1.5 py-0.5 font-mono text-4xs font-semibold uppercase tracking-widest", pill)}>
      {label}
    </span>
  );
}
