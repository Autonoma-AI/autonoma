import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@autonoma/blacklight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import type { SecretSummary } from "lib/query/secrets.queries";
import { toastManager } from "lib/toast-manager";
import { useState } from "react";

interface SecretRowProps {
  secret: SecretSummary;
  onEdit: (secret: SecretSummary) => void;
  onDelete: (secret: SecretSummary) => void;
}

export function SecretRow({ secret, onEdit, onDelete }: SecretRowProps) {
  const [copiedKey, setCopiedKey] = useState(false);

  async function handleCopyKey() {
    try {
      await navigator.clipboard.writeText(secret.key);
    } catch {
      toastManager.add({
        title: "Copy failed",
        description: "Clipboard is unavailable in this context.",
        type: "critical",
      });
      return;
    }
    setCopiedKey(true);
    toastManager.add({ title: "Key copied", description: secret.key, type: "success" });
    setTimeout(() => setCopiedKey(false), 1500);
  }

  const masked = "•".repeat(Math.max(secret.maskedLength, 8));

  return (
    <div className="group grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-4 border-b border-border-dim px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-raised">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-sm text-text-primary">{secret.key}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={handleCopyKey}
                className="shrink-0 rounded p-1 text-text-tertiary opacity-0 transition-all hover:bg-surface-base hover:text-text-primary group-hover:opacity-100"
                aria-label="Copy key"
              />
            }
          >
            {copiedKey ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </TooltipTrigger>
          <TooltipContent>Copy key</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="min-w-0 flex-1 cursor-help truncate rounded border border-border-dim bg-surface-base px-2 py-1 font-mono text-xs text-text-secondary" />
            }
          >
            {masked}
          </TooltipTrigger>
          <TooltipContent>Value is hidden. Edit to replace it.</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" onClick={() => onEdit(secret)} aria-label={`Edit ${secret.key}`} />
            }
          >
            <PencilSimpleIcon size={14} />
          </TooltipTrigger>
          <TooltipContent>Edit</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onDelete(secret)}
                aria-label={`Delete ${secret.key}`}
                className="hover:text-status-critical"
              />
            }
          >
            <TrashIcon size={14} />
          </TooltipTrigger>
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
