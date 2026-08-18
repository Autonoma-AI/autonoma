import { Diff, cn } from "@autonoma/blacklight";
import { PlanMarkdown } from "components/plan-markdown";
import { useState } from "react";

/**
 * The drawer's plan tab: the plan the run was judged against, rendered as markdown, with a toggle to the
 * checkpoint's change to it when this PR rewrote the plan. The diff view is the one place the plan stays
 * monospace - its line-for-line source is the point. A removed test passes only `previousPlan` through `plan`.
 */
export function FindingDrawerPlan({ plan, previousPlan }: { plan: string; previousPlan?: string }) {
  const [showDiff, setShowDiff] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      {previousPlan != null && (
        <div className="flex gap-1 self-start">
          <ViewPill selected={!showDiff} onClick={() => setShowDiff(false)}>
            Current plan
          </ViewPill>
          <ViewPill selected={showDiff} onClick={() => setShowDiff(true)}>
            Changed this checkpoint
          </ViewPill>
        </div>
      )}
      {showDiff && previousPlan != null ? (
        <Diff oldSource={previousPlan} newSource={plan} showLineNumbers={false} />
      ) : plan.trim() !== "" ? (
        <PlanMarkdown content={plan} />
      ) : (
        <p className="text-sm text-text-secondary">This test has no plan at this checkpoint.</p>
      )}
    </div>
  );
}

function ViewPill({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border border-border-mid px-2 py-0.5 font-mono text-3xs transition-colors",
        selected ? "border-primary text-primary" : "text-text-secondary hover:text-text-primary",
      )}
    >
      {children}
    </button>
  );
}
