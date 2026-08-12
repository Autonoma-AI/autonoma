import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@autonoma/blacklight";
import { COMMAND_SHELLS, type CommandShell } from "lib/onboarding/planner-command";
import type { ReactElement } from "react";

interface CopyCommandMenuProps {
  /** Copies the command written for the shell that was picked, and dismisses. */
  onCopy: (shell: CommandShell) => void;
  /**
   * What the menu hangs off, which is what it is positioned against - so this is the
   * copy button, not the command. Anchoring to the command block puts the popup in the
   * far corner of a box the height of the whole command, adrift from anything clicked.
   */
  trigger: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Copying asks which shell, rather than a control beside it offering to change one.
 *
 * The POSIX form of these commands cannot run in either Windows shell - PowerShell
 * reads the first `NAME=value` as a program name and stops - so the choice is not a
 * preference, it decides whether the paste works at all. A separate selector puts that
 * behind noticing it first, which the person who most needs it (on Windows, holding a
 * command that will fail) has no reason to do. Hanging it off the copy affordance means
 * nobody can take the wrong one without having been shown the right one.
 *
 * Open state is the caller's so that the command text can raise this menu too, while
 * the menu stays positioned against the button.
 */
export function CopyCommandMenu({ onCopy, trigger, open, onOpenChange }: CopyCommandMenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="end">
        {/* GroupLabel must live inside a Group - Base UI throws error #31 when it does not, at open. */}
        <DropdownMenuGroup>
          <DropdownMenuGroupLabel className="font-mono text-3xs uppercase tracking-widest text-text-secondary">
            Copy for
          </DropdownMenuGroupLabel>
          {/* Nothing marks the shell on screen: every item is an action that copies and
              dismisses, and a checkmark would read as a selection to change rather than
              a thing to take. What was detected is already visible as the form of the
              command itself. */}
          {COMMAND_SHELLS.map((option) => (
            <DropdownMenuItem key={option.id} onClick={() => onCopy(option.id)}>
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
