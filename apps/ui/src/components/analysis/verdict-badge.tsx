import { Badge, cn } from "@autonoma/blacklight";
import { analysisVerdictMeta } from "components/analysis/verdict-meta";

/**
 * The one way a verdict renders as a badge. The colored Badge variants (`critical`, `success`, ...) carry the
 * severity typography themselves but `plan_mismatch` (`secondary`) and `environment_failure` (`outline`) do not,
 * so without this normalization those two read in a different voice than every other verdict.
 */
export function VerdictBadge({ verdict, className }: { verdict: string; className?: string }) {
  const meta = analysisVerdictMeta(verdict);
  return (
    <Badge
      variant={meta.variant}
      className={cn("shrink-0 font-mono text-4xs font-bold tracking-wider uppercase", className)}
    >
      {meta.label}
    </Badge>
  );
}
