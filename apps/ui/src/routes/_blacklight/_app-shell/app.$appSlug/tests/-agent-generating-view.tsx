import { BrailleSpinner } from "@autonoma/blacklight";
import type { ActivityLine } from "../../-layout/use-branch-activity";

interface AgentGeneratingViewProps {
  activities: ActivityLine[];
}

export function AgentGeneratingView({ activities }: AgentGeneratingViewProps) {
  const genActivity = activities.find((a) => a.type === "generation");
  const genCount = genActivity?.count ?? 0;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <BrailleSpinner animation="helix" size="xl" className="text-primary-ink" />

      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-lg font-medium text-text-primary">Generating your tests</h2>
        <p className="max-w-sm font-mono text-xs text-text-secondary">
          {genCount > 0
            ? `The agent is running ${genCount} generation${genCount !== 1 ? "s" : ""} for this application. Tests will appear here once they are ready.`
            : "The agent is working on generating tests for this branch. They will appear here once ready."}
        </p>
      </div>

      {genActivity?.href != null && (
        <a
          href={genActivity.href}
          className="font-mono text-2xs text-primary-ink underline underline-offset-2 transition-colors hover:text-text-primary"
        >
          View generation progress
        </a>
      )}
    </div>
  );
}
