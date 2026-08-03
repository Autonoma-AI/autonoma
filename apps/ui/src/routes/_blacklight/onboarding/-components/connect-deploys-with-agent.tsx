import { Button } from "@autonoma/blacklight";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { ONBOARDING_MCP_SERVER_NAME } from "components/connect-agent-dialog";
import { ConnectOnboardingAgentDialog } from "components/connect-onboarding-agent-dialog";
import { useState } from "react";

/**
 * What the user asks their agent to do on the connect-your-deploys step. Names
 * the server literally so an agent holding several Autonoma MCPs cannot pick the
 * wrong one - same reason as the config step's instruction.
 */
const CONNECT_DEPLOYS_INSTRUCTION = `wire my deploy pipeline to Autonoma with the ${ONBOARDING_MCP_SERVER_NAME} MCP`;

/**
 * Agentic entry point for the bring-your-own-deploys step. The work here is
 * reading how a project actually deploys and adding a signed call to it - which
 * is exactly what a coding agent sitting in the repo is better placed to do than
 * a user copying YAML into a file and hoping their pipeline emits the right event.
 */
export function ConnectDeploysWithAgent({ applicationId }: { applicationId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="lg" className="shrink-0" onClick={() => setOpen(true)}>
        <RobotIcon weight="bold" />
        Wire it up with a coding agent
      </Button>
      <ConnectOnboardingAgentDialog
        open={open}
        onOpenChange={setOpen}
        applicationId={applicationId}
        title="Connect your deploys with a coding agent"
        description="Two commands in your terminal: install the Autonoma MCP and sign in, then start your agent. It reads how your project deploys, adds the signed call, and confirms the signal reached Autonoma."
        instruction={CONNECT_DEPLOYS_INSTRUCTION}
        capabilities="It opens a pull request with the change rather than pushing to your default branch, and checks the signal actually landed before calling it done."
      />
    </>
  );
}
