import { RouteErrorState } from "components/route-error-state";

/**
 * The issue-detail routes' last-resort boundary. Absence is not a failure (the read resolves to null and the page
 * renders its own not-found), so this only catches an UNEXPECTED error and degrades it to a calm retry rather than
 * the app-wide crash screen.
 */
export function AnalysisIssueErrorState({ reset }: { reset: () => void }) {
  return <RouteErrorState message="We couldn't load this issue." reset={reset} />;
}
