import { Badge, StatusDot } from "@autonoma/blacklight";
import type { InvestigationFinding } from "@autonoma/types";
import { analysisVerdictMeta } from "components/analysis/verdict-meta";

/**
 * The two-plane verdict headline for an authoritative PR, shown above the findings list. The app-health plane
 * (`client_bug` is the only verdict that counts against the PR) is the headline; the coverage plane (checks that
 * could not confirm app health) is a quiet, non-blocking sub-line. Every count is derived from the findings via
 * the verdict SSOT (`analysisVerdictMeta`), never hand-listed, so the split can never drift from the taxonomy.
 */
export function PrVerdictHeadline({ findings }: { findings: InvestigationFinding[] }) {
  // Derived from the verdict SSOT, never hand-listed: `actionable` is exactly the client-bug plane, `coverage` is
  // the non-blocking plane, and passed is the app-health remainder (an unknown category falls back to coverage).
  const bugCount = findings.filter((f) => analysisVerdictMeta(f.category).actionable).length;
  const coverageCount = findings.filter((f) => analysisVerdictMeta(f.category).plane === "coverage").length;
  const passedCount = findings.length - bugCount - coverageCount;
  const hasBugs = bugCount > 0;

  return (
    <div className="flex flex-col gap-3 border border-border-dim bg-surface-base px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={hasBugs ? "critical" : "success"} className="gap-1 font-mono uppercase tracking-wider">
          <StatusDot status={hasBugs ? "critical" : "success"} />
          {hasBugs ? `${bugCount} client ${bugCount === 1 ? "bug" : "bugs"}` : "No client bugs"}
        </Badge>
        {passedCount > 0 && (
          <Badge variant="status-passed" className="font-mono text-3xs">
            {passedCount} passed
          </Badge>
        )}
        {coverageCount > 0 && (
          <Badge variant="outline" className="font-mono text-3xs">
            {coverageCount} couldn&apos;t confirm
          </Badge>
        )}
      </div>

      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-text-primary">
          {hasBugs ? "This PR has app-level bugs to fix" : "The app held up on the paths we tested"}
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          {hasBugs
            ? "Only client bugs count against this PR - review each one below."
            : "Everything the agent checked passed or was non-blocking."}
          {coverageCount > 0 &&
            ` ${coverageCount} ${coverageCount === 1 ? "check" : "checks"} couldn't confirm app health this run and don't block the PR.`}
        </p>
      </div>
    </div>
  );
}
