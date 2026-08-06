import { Button } from "@autonoma/blacklight";
import { buildAgentHandoffLinks } from "@autonoma/types";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { useState } from "react";

export interface AgentHandoffActionsProps {
  /** The full brief the agent should open with. */
  prompt: string;
  /** Pre-selects the repository in Claude Code's deep-link. Omit when the surface has no repo. */
  repoFullName?: string;
}

/**
 * The two ways to get a brief into a coding agent: copy it, or open an agent with it prefilled.
 *
 * The same pair the pull-request comment offers, so a developer who has taken a finding from a PR
 * into their agent recognizes this. The deep-links carry the whole brief rather than a kickoff
 * line, but every vendor truncates a long URL somewhere, so the copy button stays the reliable
 * full source and leads.
 */
export function AgentHandoffActions({ prompt, repoFullName }: AgentHandoffActionsProps) {
  const [copied, setCopied] = useState(false);
  const links = buildAgentHandoffLinks(prompt, repoFullName);

  function copy() {
    // `navigator.clipboard` is undefined in insecure contexts, and the write can reject
    // (permissions, unfocused document) - handle both so the failure logs instead of surfacing as
    // an unhandled rejection.
    if (navigator.clipboard == null) {
      console.warn("Clipboard API unavailable; cannot copy the agent brief");
      return;
    }
    navigator.clipboard
      .writeText(prompt)
      .then(() => setCopied(true))
      .catch((err) => console.warn("Failed to copy the agent brief", err));
  }

  return (
    <span className="mt-3 flex flex-wrap items-center gap-2">
      <Button variant="accent" size="sm" className="gap-1.5" onClick={copy}>
        {copied ? <CheckIcon size={14} weight="bold" /> : <CopyIcon size={14} weight="bold" />}
        {copied ? "Copied" : "Copy prompt"}
      </Button>
      {links.map((link) => (
        <a key={link.label} href={link.href} target="_blank" rel="noreferrer">
          <Button variant="outline" size="sm" className="gap-1.5">
            <ArrowSquareOutIcon size={14} weight="bold" />
            {link.label}
          </Button>
        </a>
      ))}
    </span>
  );
}
