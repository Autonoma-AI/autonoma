import { BrailleSpinner, Button } from "@autonoma/blacklight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { StopIcon } from "@phosphor-icons/react/Stop";
import { agentDisplayName } from "lib/onboarding/agent-display-name";
import { useAgentSession, useStopAgent } from "lib/onboarding/onboarding-api";

/** What the platform has confirmed about this app, each derived from real evidence. */
export interface FinishSetupProgress {
  artifactsUploaded: boolean;
  sdkConfigured: boolean;
  dryRunPassed: boolean;
}

interface AgentFinishingScreenProps {
  applicationId: string;
  progress: FinishSetupProgress;
}

/**
 * What finish setup looks like while a coding agent is doing it.
 *
 * Deliberately not the preview step's activity screen. That one exists because the
 * agent's work is invisible - it happens inside Autonoma, and the feed is the only
 * window onto it. Here the work is happening wherever the user started their agent,
 * which is a far better window than any feed we could render. So this says where to
 * look, in one line, and gets out of the way.
 *
 * Says "where you started it" rather than naming a terminal: the same screen serves
 * a planner run in a terminal, an agent driving from an editor, and a hosted agent
 * with no human beside it at all. Only the first of those has a terminal to look at.
 *
 * The three rows underneath are not progress theatre: each is a fact the platform has
 * confirmed for itself - artifacts that landed, an endpoint that answered, scenarios
 * that provisioned - and together they answer the only question this screen leaves
 * open, which is how much is left.
 */
export function AgentFinishingScreen({ applicationId, progress }: AgentFinishingScreenProps) {
  const { data: session } = useAgentSession(applicationId);
  const stopAgent = useStopAgent();

  return (
    <div className="flex flex-col gap-6 border border-border-dim bg-surface-base px-6 py-8">
      <div className="flex items-start gap-4">
        <RobotIcon size={28} weight="light" className="mt-1 shrink-0 text-primary" />
        <div className="flex flex-col gap-2">
          <h2 className="text-xl font-medium tracking-tight text-text-primary">Your agent is finishing setup</h2>
          <p className="max-w-xl text-sm leading-relaxed text-text-secondary">
            {agentDisplayName(session?.agentClient)} is doing it where you started it. Your test suite, the Autonoma
            SDK, and a dry run of your scenarios all happen there, against the repository this page cannot read. Nothing
            here needs doing; it keeps itself up to date.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-border-dim pt-5">
        <ProgressRow done={progress.artifactsUploaded} label="Test suite uploaded to Autonoma" />
        <ProgressRow done={progress.sdkConfigured} label="Autonoma SDK answering from your app" />
        <ProgressRow done={progress.dryRunPassed} label="Scenarios provisioning against your preview" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-dim pt-5">
        <p className="max-w-md text-2xs leading-relaxed text-text-secondary">
          Taking over stops the agent and hands you the same steps to do by hand. Its run keeps going wherever you
          started it, so stop it there too.
        </p>
        <Button
          variant="outline"
          className="gap-2"
          onClick={() => stopAgent.mutate({ applicationId })}
          disabled={stopAgent.isPending}
        >
          <StopIcon size={16} weight="bold" />
          Take over
        </Button>
      </div>
    </div>
  );
}

/**
 * One thing the platform is waiting to confirm.
 *
 * Outstanding rows spin rather than sit as a static outline. This panel can go
 * unchanged for many minutes - the SDK handoff alone runs that long - and a
 * motionless icon through all of it reads as stalled, which is the one thing it
 * must not say while an agent is working. Every outstanding row spins, not just
 * whichever is "current": the work does not complete top to bottom (the SDK lands
 * before the test suite), so there is no current row to single out.
 */
function ProgressRow({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      {done ? (
        <CheckCircleIcon size={16} weight="fill" className="shrink-0 text-status-success" />
      ) : (
        <BrailleSpinner animation="braille" size="sm" className="shrink-0 text-text-secondary" />
      )}
      <span className={done ? "text-sm text-text-primary" : "text-sm text-text-secondary"}>{label}</span>
    </div>
  );
}
