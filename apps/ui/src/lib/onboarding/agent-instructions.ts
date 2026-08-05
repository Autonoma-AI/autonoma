import { MCP_SERVER_NAME } from "components/connect-agent-dialog";

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
