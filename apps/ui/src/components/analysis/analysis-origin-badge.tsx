import { Badge } from "@autonoma/blacklight";
import type { AnalysisRunFinding } from "@autonoma/types";

/**
 * Whether a test in the run pre-existed the PR (`Existing`) or was authored this run for functionality the PR adds
 * (`Proposed`). Renders nothing for a finding with no recorded origin (a legacy row).
 */
export function AnalysisOriginBadge({ origin }: { origin: AnalysisRunFinding["origin"] }) {
  if (origin === "proposed") {
    return (
      <Badge variant="secondary" className="shrink-0 font-mono text-3xs uppercase tracking-wider">
        Proposed
      </Badge>
    );
  }
  if (origin === "pre_existing") {
    return (
      <Badge variant="outline" className="shrink-0 font-mono text-3xs uppercase tracking-wider">
        Existing
      </Badge>
    );
  }
  return null;
}
