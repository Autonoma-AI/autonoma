/**
 * The exact sentence the user pastes into their coding agent to start agentic
 * onboarding. It names the Autonoma MCP: an agent with several MCPs connected cannot
 * tell which one "configure my preview" refers to, and picks wrong.
 *
 * Single source for the line the UI shows and the text the copy button puts on the
 * clipboard - people copy and paste it verbatim, so those two must never drift.
 */
export function agentConfigurePrompt(code?: string): string {
    const instruction = "configure my preview with the Autonoma MCP";
    return code != null ? `${instruction}, code ${code}` : instruction;
}
