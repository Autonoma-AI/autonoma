import { Button } from "@autonoma/blacklight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { useState } from "react";
import { agentConfigurePrompt } from "./agent-configure-prompt";

/**
 * Copies the whole agent prompt, not just the bare code - the code alone is useless
 * to paste, and someone who copies it still has to type the instruction around it.
 * The icon flips to a check once copied.
 *
 * Positions itself at the right edge of its container, so the pairing-code block it
 * sits in must be `relative`.
 */
export function CopyPromptButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    // `navigator.clipboard` is undefined in insecure contexts, and the write can
    // reject (permissions, unfocused document) - handle both so the failure logs
    // instead of surfacing as an unhandled rejection, and the check stays false.
    if (navigator.clipboard == null) {
      console.warn("Clipboard API unavailable; cannot copy agent prompt");
      return;
    }
    navigator.clipboard
      .writeText(agentConfigurePrompt(code))
      .then(() => setCopied(true))
      .catch((err) => console.warn("Failed to copy agent prompt", err));
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary"
      onClick={copy}
      aria-label="Copy the prompt for your agent"
    >
      {copied ? <CheckIcon className="text-status-success" /> : <CopyIcon />}
    </Button>
  );
}
