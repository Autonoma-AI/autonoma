import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { FixWithAgentButton } from "components/fix-with-agent-button";
import type { DryRunOutcome } from "lib/format-dry-run-error";
import { AGENT_INSTRUCTIONS } from "lib/onboarding/agent-instructions";

/**
 * The last dry run's result, rendered to stay on screen until the next one.
 *
 * A failure's reason is often the only account of what went wrong: a run that fails before
 * the SDK call - a recipe that will not resolve - creates no scenario instance to inspect
 * and writes no line to the preview logs. So it is shown here rather than only in a toast
 * that is gone within seconds.
 */
export function DryRunOutcomeNote({ outcome }: { outcome: DryRunOutcome }) {
  if (outcome.success) {
    return (
      <span className="flex items-center gap-1.5 text-2xs text-status-success">
        <CheckCircleIcon size={14} weight="fill" className="shrink-0" />
        Dry run passed - test data was created and torn down.
      </span>
    );
  }

  return (
    <div className="flex items-start gap-1.5 border border-status-critical/30 bg-status-critical/5 px-2.5 py-2">
      <WarningCircleIcon size={14} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-2xs font-medium text-status-critical">
          Dry run failed{outcome.phase != null ? ` during ${outcome.phase}` : ""}
        </span>
        {outcome.error != null && outcome.error !== "" && (
          <p className="whitespace-pre-wrap break-words font-mono text-3xs text-status-critical/90">{outcome.error}</p>
        )}
        <FixWithAgentButton
          instruction={AGENT_INSTRUCTIONS.dryRun}
          capabilities="It can read the recipe, try edits against your deployed SDK without saving them, and fix the SDK handler in your repo."
          size="xs"
        />
      </div>
    </div>
  );
}
