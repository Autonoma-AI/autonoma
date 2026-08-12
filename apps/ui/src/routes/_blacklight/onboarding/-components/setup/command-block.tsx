import { Button } from "@autonoma/blacklight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { CopyCommandMenu } from "components/copy-command-menu";
import { copyText } from "lib/clipboard";
import type { CommandShell } from "lib/onboarding/planner-command";
import { toastManager } from "lib/toast-manager";
import { useEffect, useState } from "react";

const COPIED_RESET_MS = 2000;

interface CommandBlockProps {
  /** Renders the command for a shell; undefined until the setup's token exists. */
  buildCommand: (shell: CommandShell) => string | undefined;
  shell: CommandShell;
  onShellChange: (shell: CommandShell) => void;
}

/**
 * A shell command the user has to run themselves.
 *
 * The copy affordance is a full accent CTA rather than an icon in the block's
 * corner: on a page where everything else is grey, a grey corner icon read as
 * decoration and people moved on without ever running the command. The block
 * itself stays clickable as a shortcut, but the button is what carries the
 * action, and the toast is where the "now paste it" instruction lives so the
 * step body does not have to spend a paragraph on it.
 */
export function CommandBlock({ buildCommand, shell, onShellChange }: CommandBlockProps) {
  const [copied, setCopied] = useState(false);
  // Owned here rather than inside the menu so the command text can raise it while the
  // popup stays anchored to the copy button.
  const [menuOpen, setMenuOpen] = useState(false);
  const command = buildCommand(shell);
  // A `$` prompt in front of a one-liner reads as "this is a shell command". In front
  // of the Windows forms, which set each variable on its own line, it would mark only
  // the first of several - and sit next to PowerShell's own `$env:`.
  const isSingleLine = command != null && !command.includes("\n");

  // Drop the confirmation again so the block reads as copyable a second time
  // instead of being stuck on "Copied".
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleCopy(picked: CommandShell) {
    onShellChange(picked);
    // The command on screen is still written for the previous shell for one render, so
    // rebuild it here rather than copying what is displayed.
    const pickedCommand = buildCommand(picked);
    if (pickedCommand == null) return;
    const didCopy = await copyText(pickedCommand);
    if (!didCopy) {
      // The block itself stays selectable, so say that rather than going quiet -
      // this step cannot be finished without the command in hand.
      toastManager.add({
        type: "critical",
        title: "Couldn't reach your clipboard",
        description: "Select the command above and copy it by hand.",
      });
      return;
    }
    setCopied(true);
    toastManager.add({
      type: "success",
      title: "Command copied",
      description: "Paste it into your terminal, from your repo's root directory.",
    });
  }

  if (command == null) {
    return (
      <div className="border border-border-dim bg-surface-raised p-3">
        <code className="block font-mono text-2xs leading-relaxed text-text-secondary">
          Preparing your CLI command...
        </code>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={() => setMenuOpen(true)}
        aria-label="Copy command to clipboard"
        className="block w-full cursor-pointer border border-border-dim bg-surface-raised p-3 text-left transition-colors hover:border-primary-ink/40"
      >
        <code className="block select-text whitespace-pre-wrap break-all font-mono text-2xs leading-relaxed text-text-secondary">
          {isSingleLine && (
            <span aria-hidden className="select-none">
              ${" "}
            </span>
          )}
          {command}
        </code>
      </button>
      <CopyCommandMenu
        onCopy={(picked) => void handleCopy(picked)}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        trigger={
          <Button variant="cta" size="sm" className="w-fit gap-1.5">
            {copied ? <CheckIcon size={12} weight="bold" /> : <CopyIcon size={12} />}
            {copied ? "Copied" : "Copy command"}
          </Button>
        }
      />
    </div>
  );
}
