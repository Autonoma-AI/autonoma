import { Button, cn } from "@autonoma/blacklight";
import "./code-block.css";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { toastManager } from "lib/toast-manager";
import { useState } from "react";

interface CodeBlockProps {
  children: string;
  copyValue?: string;
  /** When true, only the first line is shown with a toggle to expand. */
  collapsible?: boolean;
  /** Label shown next to the toggle when collapsed. Defaults to the first line of children. */
  collapsedLabel?: string;
  /** Whether this code block is the current active step to copy. */
  isActive?: boolean;
  /** Callback fired after a successful copy. */
  onCopied?: () => void;
}

export function CodeBlock({ children, copyValue, collapsible, collapsedLabel, isActive, onCopied }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(copyValue ?? children);
      toastManager.add({ type: "success", title: "Copied", description: "Command copied to clipboard." });
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      if (isActive === true) onCopied?.();
    } catch {
      toastManager.add({
        type: "critical",
        title: "Copy failed",
        description: "Could not write to clipboard. Try selecting the text manually.",
      });
    }
  }

  const isCollapsed = collapsible === true && !expanded;
  const firstLine = collapsedLabel ?? children.split("\n")[0] ?? "";

  return (
    <div
      className={cn(
        "group border bg-surface-base",
        isActive === true
          ? "border-primary-ink"
          : "overflow-hidden border-border-dim transition-colors hover:border-primary/30",
      )}
      style={isActive === true ? { animation: "heartbeat-border 2s ease-in-out infinite" } : undefined}
    >
      <div className="flex min-w-0 items-start justify-between gap-4 p-4">
        {isCollapsed ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          >
            <CaretRightIcon size={14} className="shrink-0 text-text-tertiary" />
            <span className="min-w-0 flex-1 truncate font-mono text-sm tracking-tight text-text-secondary">
              {firstLine}
            </span>
          </button>
        ) : (
          <div className="min-w-0 flex-1">
            {collapsible === true && (
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="mb-2 flex cursor-pointer items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary"
              >
                <CaretDownIcon size={14} />
                <span>Collapse</span>
              </button>
            )}
            <pre className="min-w-0 flex-1 overflow-x-hidden font-mono text-sm tracking-tight whitespace-pre-wrap break-all text-text-secondary">
              {children}
            </pre>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleCopy}
          className="ml-4 shrink-0 self-start"
          title="Copy command"
        >
          {copied ? <CheckIcon size={16} className="text-status-success" /> : <CopyIcon size={16} />}
        </Button>
      </div>
    </div>
  );
}
