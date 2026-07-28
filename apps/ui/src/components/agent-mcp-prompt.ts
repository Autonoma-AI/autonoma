/**
 * The sentence the user hands to their coding agent, with the pairing code appended.
 *
 * `instruction` must name the MCP server LITERALLY (`autonoma-onboarding`, not "the Autonoma
 * MCP"): we ship two similarly named servers, and an agent with both connected cannot tell a
 * generic name apart - it picks one and commits to it, which is how a "why is my dry run
 * failing" prompt ended up on the onboarding server asking for a pairing code the user had
 * never been shown.
 *
 * Single source for the line the UI displays and the text the copy button puts on the
 * clipboard - people paste it verbatim, so those two must never drift.
 */
export function agentMcpPrompt(instruction: string, code?: string): string {
    return code != null ? `${instruction}, code ${code}` : instruction;
}
