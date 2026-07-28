/**
 * The reason every "ask your agent" example spells out the MCP by its registered name:
 * an agent with several MCPs connected cannot tell which one a bare "fix my preview"
 * refers to, and picks wrong. Autonoma ships two of them, so "the Autonoma MCP" is not
 * specific enough either - only the literal server name is. Shared by every connect-agent
 * surface so they cannot drift into different explanations of the same rule.
 */
export function NameTheMcpNote({ serverName }: { serverName: string }) {
  return (
    <>
      Say <span className="font-mono text-text-primary">{serverName}</span> by name: an agent with several MCPs
      connected cannot tell which one you mean.
    </>
  );
}
