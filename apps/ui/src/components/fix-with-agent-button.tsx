import { Button } from "@autonoma/blacklight";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { useState, type ReactNode } from "react";
import { ConnectAgentDialog } from "./connect-agent-dialog";
import { NameTheMcpNote } from "./name-the-mcp-note";

export interface FixWithAgentButtonProps {
  /**
   * The instruction half of the prompt, from `AGENT_INSTRUCTIONS`. Taken from that table
   * rather than written inline so every surface reporting one failure asks the agent for the
   * same thing.
   */
  instruction: string;
  /** What the agent can do once connected, shown under the prompt. The MCP-by-name note is added for you. */
  capabilities: ReactNode;
  label?: string;
  variant?: "accent" | "ghost" | "outline";
  size?: "xs" | "sm";
}

/**
 * "Fix with coding agent" next to a failure the Autonoma MCP can repair.
 *
 * No pairing code: every surface using this is reachable only after setup, so the agent
 * identifies the app from the repo it is already sitting in, and the deploy and runtime tools
 * it needs - app and build logs, deploy status, endpoints, secret status - are on the same
 * server it would have connected during onboarding.
 *
 * The dialog owns its own open state, so a caller can drop this next to an error message without
 * threading state through the components in between, however deeply the error is rendered.
 */
export function FixWithAgentButton({
  instruction,
  capabilities,
  label = "Fix with coding agent",
  // Outline rather than the accent the finish-setup steps use: those sit in a neutral row,
  // where accent is the only thing drawing the eye. Here the button sits inside an
  // already-red block that has the reader's attention, and accent green on it just fights.
  variant = "outline",
  size = "sm",
}: FixWithAgentButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant={variant} size={size} className="mt-1.5 gap-1.5 self-start" onClick={() => setOpen(true)}>
        <RobotIcon size={14} weight="bold" />
        {label}
      </Button>
      <ConnectAgentDialog
        open={open}
        onOpenChange={setOpen}
        title="Fix with a coding agent"
        description="Install the Autonoma MCP in your coding agent. It picks up the repo from your local git and connects automatically - no pairing code to paste."
        instruction={instruction}
        capabilities={
          <>
            <NameTheMcpNote /> {capabilities}
          </>
        }
      />
    </>
  );
}
