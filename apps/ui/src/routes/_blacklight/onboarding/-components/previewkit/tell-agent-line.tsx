import { agentConfigurePrompt } from "./agent-configure-prompt";

/**
 * The sentence the user hands to their coding agent to start agentic onboarding,
 * shared by the MCP-first page and the configure-with-agent modal so both quote the
 * same words - and the same words the pairing-code copy button puts on the clipboard.
 */
export function TellAgentLine({ code }: { code?: string }) {
  return (
    <>
      Then tell your agent: <span className="font-mono text-text-primary">{agentConfigurePrompt(code)}</span>
    </>
  );
}
