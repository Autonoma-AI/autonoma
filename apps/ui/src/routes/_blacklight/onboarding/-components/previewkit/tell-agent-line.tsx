/**
 * The sentence the user hands to their coding agent, quoted the same way on every
 * surface that shows one - the MCP-first page, the configure-with-agent modal -
 * and matching what the pairing-code copy button puts on the clipboard. Takes the
 * sentence rather than building it, since each step asks for something different.
 */
export function TellAgentLine({ prompt }: { prompt: string }) {
  return (
    <>
      Then tell your agent: <span className="font-mono text-text-primary">{prompt}</span>
    </>
  );
}
