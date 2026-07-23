import { Button, Skeleton } from "@autonoma/blacklight";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import {
  ConnectAgentDialog,
  ONBOARDING_MCP_DOCS_URL,
  ONBOARDING_MCP_SERVER_NAME,
} from "components/connect-agent-dialog";
import { useCreateAgentPairing } from "lib/onboarding/onboarding-api";
import { useState } from "react";

/**
 * Entry point for agentic onboarding: a button that mints a short-lived pairing
 * code and opens the shared connect-agent dialog showing, per coding agent, how to
 * install the onboarding MCP - plus the code the user hands to their agent
 * ("configure with code ..."). The agent authenticates via OAuth on first use; the
 * code pins this app.
 */
export function ConfigureWithAgentModal({ applicationId }: { applicationId: string }) {
  const [open, setOpen] = useState(false);
  const createPairing = useCreateAgentPairing();

  function openAndPair() {
    setOpen(true);
    createPairing.mutate({ applicationId });
  }

  const code = createPairing.data?.code;

  return (
    <>
      <Button variant="outline" size="lg" className="shrink-0" onClick={openAndPair} disabled={createPairing.isPending}>
        <RobotIcon weight="bold" />
        Configure with coding agent
      </Button>
      <ConnectAgentDialog
        open={open}
        onOpenChange={setOpen}
        title="Configure with a coding agent"
        description="Install the Autonoma MCP in your coding agent, then give it the pairing code below. It will configure and deploy your preview while you watch here."
        serverName={ONBOARDING_MCP_SERVER_NAME}
        endpoint="onboarding"
        docsUrl={ONBOARDING_MCP_DOCS_URL}
        pairing={
          <PairingCode
            code={code}
            pending={createPairing.isPending}
            error={createPairing.isError}
            onRetry={() => createPairing.mutate({ applicationId })}
          />
        }
        tellAgent={
          <>
            Then tell your agent: <span className="font-mono text-text-primary">configure my preview</span>
            {code != null ? (
              <>
                {" "}
                with code <span className="font-mono text-primary">{code}</span>.
              </>
            ) : (
              "."
            )}
          </>
        }
      />
    </>
  );
}

function PairingCode({
  code,
  pending,
  error,
  onRetry,
}: {
  code?: string;
  pending: boolean;
  error: boolean;
  onRetry: () => void;
}) {
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
