/**
 * The sentence the user hands to their coding agent, with the pairing code appended.
 *
 * `instruction` must name the MCP server LITERALLY (`autonoma`, not "the Autonoma MCP"): an
 * agent with several MCPs connected cannot tell a generic name apart - it picks one and commits
 * to it, which is how a "why is my dry run failing" prompt ended up on the wrong server.
 *
 * Single source for the line the UI displays and the text the copy button puts on the
 * clipboard - people paste it verbatim, so those two must never drift.
 */
export function agentMcpPrompt(instruction: string, code?: string): string {
    return code != null ? `${instruction}, code ${code}` : instruction;
}
