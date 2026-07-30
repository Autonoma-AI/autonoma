/**
 * What the user asks their coding agent, per kind of failure an Autonoma MCP can repair.
 *
 * Each entry takes the server name and spells it out in the sentence, because an agent holding
 * more than one Autonoma MCP cannot resolve a prompt that names neither, and "the Autonoma MCP"
 * names both. The name is a parameter rather than baked in because the same failure is reachable
 * from surfaces backed by different servers - a dry run fails inside finish-setup, where the
 * onboarding MCP is already paired, and again on the scenarios page, where an established user
 * has the debug MCP keyed to their repo.
 *
 * Keyed by the failure, not by the screen it appears on, so two surfaces reporting one broken
 * endpoint hand the agent the same sentence.
 */
export const AGENT_INSTRUCTIONS = {
    sdk: (server: string) => `use the ${server} MCP to validate my Autonoma SDK endpoint and fix it if it fails`,
    dryRun: (server: string) => `use the ${server} MCP to find out why my scenario dry run is failing`,
    provision: (server: string) =>
        `use the ${server} MCP to find out why provisioning a test user against my preview is failing`,
} as const;
