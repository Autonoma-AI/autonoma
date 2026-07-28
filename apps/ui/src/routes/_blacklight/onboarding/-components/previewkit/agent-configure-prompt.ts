import { agentMcpPrompt } from "components/agent-mcp-prompt";
import { ONBOARDING_MCP_SERVER_NAME } from "components/connect-agent-dialog";

/**
 * What the user asks their coding agent to do at the config-previews step. It names the
 * server literally so an agent holding several Autonoma MCPs cannot pick the wrong one.
 */
export const AGENT_CONFIGURE_INSTRUCTION = `configure my preview with the ${ONBOARDING_MCP_SERVER_NAME} MCP`;

/** That instruction plus the pairing code - the exact sentence the user pastes into their agent. */
export function agentConfigurePrompt(code?: string): string {
    return agentMcpPrompt(AGENT_CONFIGURE_INSTRUCTION, code);
}
