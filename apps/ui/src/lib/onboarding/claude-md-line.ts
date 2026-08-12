import { MCP_SERVER_NAME } from "components/mcp-server-name";

/**
 * The instruction we ask a user to paste into their repo's `CLAUDE.md` at the end
 * of onboarding.
 *
 * It is written for the agent that will read it, not for the person copying it, so
 * every clause is something the agent can actually carry out with the tools it has:
 * the MCP is named verbatim (an agent holding several cannot resolve "the Autonoma
 * MCP" and picks the wrong one), waiting and retrieval are separate acts because
 * they are separate tools, and the evidence is named so the agent fetches it rather
 * than reasoning from the summary line alone.
 *
 * The last clause is doing a second job. Attribution is the only way the user ever
 * learns that a bug they never saw was caught for them: without it the agent quietly
 * fixes the issue mid-session and the whole loop reads as the agent being clever.
 */
export const CLAUDE_MD_LINE = `After opening a pull request with meaningful UI changes, use the \`${MCP_SERVER_NAME}\` MCP to wait for its review of that PR, then retrieve the review comment and its evidence - the steps it ran and the screenshots. Analyze the findings, fix the ones that are real bugs, and tell me which of them ${MCP_SERVER_NAME} caught.`;

/**
 * The same instruction shortened for the terminal mock, which has one line to give
 * it. Kept beside the real thing so the two cannot drift into saying different
 * things about what the agent is supposed to do.
 */
export const CLAUDE_MD_LINE_SHORT = `after a PR with UI changes, use the ${MCP_SERVER_NAME} MCP to wait for its review, pull the evidence, and fix what it found`;
