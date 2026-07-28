/**
 * The reason every "ask your agent" example spells out "the Autonoma MCP": an agent
 * with several MCPs connected cannot tell which one a bare "fix my preview" refers
 * to, and picks wrong. Shared by the debug-MCP surfaces so the three of them cannot
 * drift into three different explanations of the same rule.
 */
export function NameTheMcpNote() {
  return <>Name the MCP: an agent with several connected cannot tell which one you mean.</>;
}
