/**
 * MCP server name every install snippet registers. One name because there is one server:
 * it carries the onboarding tools and the pull-request debugging tools alike, and which
 * job an agent is doing is decided by the prompt it is started on, not by what it connected
 * to. Example prompts still say it verbatim - see `NameTheMcpNote`.
 *
 * In a module of its own, not on the dialog that renders it: the prompt builders need the
 * name and nothing else, and reaching it through the dialog dragged the whole tRPC client
 * (and so `window`) into anything that imported one.
 */
export const MCP_SERVER_NAME = "autonoma";
