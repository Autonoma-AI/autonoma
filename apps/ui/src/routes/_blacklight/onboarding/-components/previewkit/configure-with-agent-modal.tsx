import { Button } from "@autonoma/blacklight";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { ConnectOnboardingAgentDialog } from "components/connect-onboarding-agent-dialog";
import { useState } from "react";
import { AGENT_CONFIGURE_INSTRUCTION } from "./agent-configure-prompt";

/**
 * Entry point for agentic onboarding: a button that opens the shared connect-agent
 * dialog showing, per coding agent, how to install the onboarding MCP - plus the
 * pairing code and the prompt the user hands to their agent. The agent authenticates
 * via OAuth on first use; the code pins this app.
 */
export function ConfigureWithAgentModal({ applicationId }: { applicationId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="lg" className="shrink-0" onClick={() => setOpen(true)}>
        <RobotIcon weight="bold" />
        Configure with coding agent
      </Button>
      <ConnectOnboardingAgentDialog
        open={open}
        onOpenChange={setOpen}
        applicationId={applicationId}
        title="Configure with a coding agent"
        description="Connect Autonoma's MCP to your coding agent and start it on the job. It configures and deploys your preview while you watch here."
        instruction={AGENT_CONFIGURE_INSTRUCTION}
      />
    </>
  );
}
