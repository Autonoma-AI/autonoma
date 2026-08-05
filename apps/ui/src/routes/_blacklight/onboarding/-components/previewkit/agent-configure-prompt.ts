import { MCP_SERVER_NAME } from "components/connect-agent-dialog";

/**
 * What the user asks their coding agent to do at the config-previews step. It names the
 * server literally so an agent holding several Autonoma MCPs cannot pick the wrong one.
 *
 * Used by the manual "configure with an agent" modal; the CLI writes its own prompt for
 * the agent it spawns.
 */
export const AGENT_CONFIGURE_INSTRUCTION = `configure my preview with the ${MCP_SERVER_NAME} MCP`;
