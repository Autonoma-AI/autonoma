import { Button } from "@autonoma/blacklight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { useState } from "react";

export function CopyPromptButton({ prompt, disabled = false }: { prompt: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    // `navigator.clipboard` is undefined in insecure contexts, and the write can reject (permissions, unfocused
    // document) - handle both so the failure logs instead of surfacing as an unhandled rejection.
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
    <Button variant="ghost" size="sm" className="gap-1.5" onClick={copy} disabled={disabled}>
      {copied ? <CheckIcon size={14} weight="bold" /> : <CopyIcon size={14} weight="bold" />}
      {copied ? "Copied" : "Copy the prompt"}
    </Button>
  );
}
