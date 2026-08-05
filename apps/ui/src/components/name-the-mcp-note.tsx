import { MCP_SERVER_NAME } from "./connect-agent-dialog";

/**
 * The reason every "ask your agent" example spells out the MCP by its registered name:
 * an agent with several MCPs connected cannot tell which one a bare "fix my preview"
 * refers to, and picks wrong. Shared by every connect-agent surface so they cannot drift
 * into different explanations of the same rule.
 */
export function NameTheMcpNote() {
  return (
    <>
      Say <span className="font-mono text-text-primary">{MCP_SERVER_NAME}</span> by name: an agent with several MCPs
      connected cannot tell which one you mean.
    </>
  );
}
