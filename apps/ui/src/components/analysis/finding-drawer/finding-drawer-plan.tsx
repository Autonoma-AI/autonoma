import { Diff, cn } from "@autonoma/blacklight";
import { useState } from "react";

/**
 * The drawer's plan tab: the plan the run was judged against, with a toggle to the checkpoint's change to it
 * when this PR rewrote the plan. A removed test passes only `previousPlan` content through `plan`.
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
      ) : (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-void p-4 font-mono text-2xs text-text-secondary">
          {plan.trim() !== "" ? plan : "This test has no plan at this checkpoint."}
        </pre>
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
