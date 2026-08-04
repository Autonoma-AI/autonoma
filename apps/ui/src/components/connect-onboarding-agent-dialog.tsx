import { Button, Skeleton } from "@autonoma/blacklight";
import { useCreateAgentPairing } from "lib/onboarding/onboarding-api";
import { useActiveOrg } from "lib/query/auth.queries";
import { useEffect, useRef, type ReactNode } from "react";
import { agentMcpPrompt } from "./agent-mcp-prompt";
import { ConnectAgentDialog, ONBOARDING_MCP_DOCS_URL, ONBOARDING_MCP_SERVER_NAME } from "./connect-agent-dialog";

/**
 * What the dialog says above the install steps on every surface that is NOT the first
 * config step - by then the user has usually installed this server already, so the copy
 * leads with "the same one" instead of introducing it from scratch.
 */
export const ONBOARDING_AGENT_DIALOG_DESCRIPTION =
  "Autonoma's onboarding MCP - the same one that configures previews. Run this in your project to connect it and start your agent on the job. If you already have it installed, running it again is harmless.";

export interface ConnectOnboardingAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
  title: string;
  description: string;
  /**
   * The instruction half of the prompt, already naming the MCP server - e.g.
   * "use the autonoma-onboarding MCP to find out why my scenario dry run is failing".
   * The pairing code is appended for you.
   */
  instruction: string;
  /** What the agent can do once it is paired, shown after the prompt. */
  capabilities?: ReactNode;
}

/**
 * The connect-agent dialog for the onboarding MCP: mints a pairing code while it is open
 * and shows the prompt to paste, code included.
 *
 * Every step of onboarding hands off to this ONE server. It used to point at the debug MCP
 * from the SDK step onward, which meant asking someone mid-onboarding to install a second,
 * similarly named Autonoma server - and an agent holding both simply picked whichever it
 * liked for a prompt that named neither.
 */
export function ConnectOnboardingAgentDialog({
  open,
  onOpenChange,
  applicationId,
  title,
  description,
  instruction,
  capabilities,
}: ConnectOnboardingAgentDialogProps) {
  const createPairing = useCreateAgentPairing();
  // In the demo the base dialog bounces to the sign-up modal (the demo org is locked out of the
  // MCP), so never mint - the pairing write would just be rejected anyway.
  const isDemo = useActiveOrg().data?.isDemo === true;

  // Mint on open, and only once per opening: codes are single-use and short-lived, so
  // a fresh one per visit is right, but a re-render (or React's dev double-mount) must
  // not churn the code the user is reading. Cleared on close so reopening re-mints.
  const mintedFor = useRef<string | undefined>(undefined);
  const mintPairing = createPairing.mutate;
  useEffect(() => {
    if (!open || isDemo) {
      mintedFor.current = undefined;
      return;
    }
    if (mintedFor.current === applicationId) return;
    mintedFor.current = applicationId;
    mintPairing({ applicationId });
  }, [open, isDemo, applicationId, mintPairing]);

  const code = createPairing.data?.code;
  const prompt = agentMcpPrompt(instruction, code);

  return (
    <ConnectAgentDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      serverName={ONBOARDING_MCP_SERVER_NAME}
      endpoint="onboarding"
      docsUrl={ONBOARDING_MCP_DOCS_URL}
      prompt={prompt}
      capabilities={capabilities}
      pairing={
        <AgentPairingCode
          code={code}
          pending={createPairing.isPending}
          error={createPairing.isError}
          onRetry={() => mintPairing({ applicationId })}
        />
      }
    />
  );
}

export interface AgentPairingCodeProps {
  code?: string;
  pending: boolean;
  error: boolean;
  onRetry: () => void;
}

/**
 * The pairing code block shown inside a connect-agent dialog (or a skeleton / retry while
 * it mints). Read-only: the code is already inside the command below it, so there is
 * nothing here worth copying on its own.
 */
export function AgentPairingCode({ code, pending, error, onRetry }: AgentPairingCodeProps) {
  if (pending) return <Skeleton className="h-16 w-full" />;
  if (error || code == null) {
    return (
      <div className="flex flex-col items-center gap-2 border border-status-critical/40 bg-surface-raised p-4">
        <span className="text-2xs text-status-critical">Couldn't generate a pairing code.</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1 border border-border-dim bg-surface-raised p-4">
      <span className="text-2xs uppercase tracking-wide text-text-secondary">Pairing code</span>
      <span className="font-mono text-3xl tracking-[0.3em] text-primary">{code}</span>
    </div>
  );
}
