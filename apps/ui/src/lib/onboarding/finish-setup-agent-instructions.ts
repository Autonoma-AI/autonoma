import { ONBOARDING_MCP_SERVER_NAME } from "components/connect-agent-dialog";

/**
 * What the user asks their coding agent on each finish-setup step that offers one.
 *
 * Both name the MCP server literally - the same `autonoma-onboarding` they installed to
 * configure the preview - so finishing setup never asks for a second Autonoma MCP, and an
 * agent holding more than one cannot pick the wrong server for a prompt naming neither.
 */
export const FINISH_SETUP_AGENT_INSTRUCTIONS = {
    sdk: `use the ${ONBOARDING_MCP_SERVER_NAME} MCP to validate my Autonoma SDK endpoint and fix it if it fails`,
    dryRun: `use the ${ONBOARDING_MCP_SERVER_NAME} MCP to find out why my scenario dry run is failing`,
} as const;
