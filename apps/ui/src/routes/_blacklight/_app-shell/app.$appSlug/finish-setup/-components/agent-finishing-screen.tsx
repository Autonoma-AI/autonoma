import { Button } from "@autonoma/blacklight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleDashedIcon } from "@phosphor-icons/react/CircleDashed";
import { StopIcon } from "@phosphor-icons/react/Stop";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
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
 * window onto it. Here the work is happening in a terminal the user opened, which is
 * a far better window than any feed we could render. So this says where to look, in
 * one line, and gets out of the way.
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
        <TerminalWindowIcon size={28} weight="light" className="mt-1 shrink-0 text-primary" />
        <div className="flex flex-col gap-2">
          <h2 className="text-xl font-medium tracking-tight text-text-primary">Continue in your terminal</h2>
          <p className="max-w-xl text-sm leading-relaxed text-text-secondary">
            {agentDisplayName(session?.agentClient)} is finishing this setup where you started it. Your test suite, the
            Autonoma SDK, and a dry run of your scenarios all happen there - it reads your repo and asks you questions
            this page cannot. Nothing here needs doing; it keeps itself up to date.
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
          Taking over stops the agent and hands you the same steps to do by hand. Its run keeps going in your terminal,
          so stop it there too.
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

function ProgressRow({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      {done ? (
        <CheckCircleIcon size={16} weight="fill" className="shrink-0 text-status-success" />
      ) : (
        <CircleDashedIcon size={16} className="shrink-0 text-text-secondary" />
      )}
      <span className={done ? "text-sm text-text-primary" : "text-sm text-text-secondary"}>{label}</span>
    </div>
  );
}
