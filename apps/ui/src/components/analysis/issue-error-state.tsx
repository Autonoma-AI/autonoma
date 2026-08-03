import { Button } from "@autonoma/blacklight";
import { WarningOctagonIcon } from "@phosphor-icons/react/WarningOctagon";

/**
 * The issue-detail routes' last-resort boundary. Absence is not a failure (the read resolves to null and the page
 * renders its own not-found), so this only catches an UNEXPECTED error and degrades it to a calm retry rather than
 * the app-wide crash screen.
 */
export function AnalysisIssueErrorState({ reset }: { reset: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border-dim bg-surface-base px-6 py-12 text-center">
      <WarningOctagonIcon size={28} className="text-text-secondary" />
      <p className="text-sm text-text-secondary">We couldn&apos;t load this issue.</p>
      <Button variant="outline" size="xs" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
