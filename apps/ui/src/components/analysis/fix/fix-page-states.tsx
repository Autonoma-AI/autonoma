import { EmptyState } from "@autonoma/blacklight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { WarningOctagonIcon } from "@phosphor-icons/react/WarningOctagon";
import { RouteErrorState } from "components/route-error-state";

export function AnalysisFixEmptyState({ status }: { status: "no_analysis" | "in_progress" | "failed" }) {
  if (status === "in_progress") {
    return (
      <EmptyState
        icon={<CircleNotchIcon size={28} className="animate-spin" />}
        title="Autonoma is still running"
        description="This pull request is being checked against its preview. Come back once the run lands and every issue it found will be here, ready to hand to your agent."
      />
    );
  }
  if (status === "failed") {
    return (
      <EmptyState
        icon={<WarningOctagonIcon size={28} />}
        title="The run never landed"
        description="Autonoma could not finish checking this pull request, so there are no findings to hand over - not the same as a clean run. Push a commit or start a new analysis to try again."
      />
    );
  }
  return (
    <EmptyState
      icon={<RobotIcon size={28} />}
      title="Nothing analyzed yet"
      description="Autonoma has not checked this pull request, so there is nothing to hand to a coding agent."
    />
  );
}

export function AnalysisFixNoIssuesState() {
  return (
    <EmptyState
      icon={<CheckCircleIcon size={28} className="text-status-success" />}
      title="Nothing to fix"
      description="Every issue Autonoma opened on this pull request is resolved. There is no brief to hand over."
    />
  );
}

export function AnalysisFixErrorState({ reset }: { reset?: () => void }) {
  return <RouteErrorState message="Could not load this pull request's findings." reset={reset} />;
}
