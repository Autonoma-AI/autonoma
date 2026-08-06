import { MCP_SERVER_NAME } from "components/mcp-server-name";

/**
 * What the user asks their coding agent, per kind of failure the Autonoma MCP can repair.
 *
 * Each sentence spells the server out by name, because an agent holding several MCPs cannot
 * resolve a prompt that names none of them. Keyed by the failure, not by the screen it appears
 * on, so two surfaces reporting one broken endpoint hand the agent the same sentence - the same
 * server answers on both, whether the user connected it during onboarding or afterwards.
 */
export const AGENT_INSTRUCTIONS = {
    sdk: `use the ${MCP_SERVER_NAME} MCP to validate my Autonoma SDK endpoint and fix it if it fails`,
    dryRun: `use the ${MCP_SERVER_NAME} MCP to find out why my scenario dry run is failing`,
    provision: `use the ${MCP_SERVER_NAME} MCP to find out why provisioning a test user against my preview is failing`,
} as const;

/**
 * How long the failure may run inside the launch command. The whole thing is one shell line the
 * user pastes into a terminal, and an SDK error can carry a whole serialized response body - past
 * a sentence or so it stops reading as a command and starts reading as a wall of text.
 */
const INSTRUCTION_ERROR_CHARS = 160;

/**
 * The same SDK instruction, but naming the failure the user is actually looking at.
 *
 * {@link AGENT_INSTRUCTIONS.sdk} says "fix it if it fails", which asks the agent to go and
 * reproduce something we already know the answer to. Where the error is in hand, the agent should
 * start from it - the full account is in the brief this is handed out alongside, but the opening
 * sentence is what a client with no room for the brief (a launch command, a chat box) gets.
 */
export function sdkFixInstruction(error: string): string {
    // Collapsed to one line: this ends up inside a double-quoted shell argument, where a newline
    // would split the command in two.
    const oneLine = error.replace(/\s+/g, " ").trim();
    const summary =
        oneLine.length > INSTRUCTION_ERROR_CHARS ? `${oneLine.slice(0, INSTRUCTION_ERROR_CHARS)}...` : oneLine;
    // Single quotes, not double: this sits inside a double-quoted shell argument, where a double
    // quote is escaped to `\"` and the command stops being readable at a glance.
    return `use the ${MCP_SERVER_NAME} MCP to fix my Autonoma SDK endpoint - validating it against my preview fails with '${summary}'`;
}
