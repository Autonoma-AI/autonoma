import { Button, Input, cn } from "@autonoma/blacklight";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { useState } from "react";

export interface EditableTextProps {
  value: string;
  onSave: (next: string) => void;
  isPending?: boolean;
  /** Classes for the display-mode container (typography inherited by the shown text). */
  className?: string;
  /** Classes for the edit-mode input, e.g. to match the display typography. */
  inputClassName?: string;
  /** Accessible label for the value and the edit affordance. */
  ariaLabel?: string;
}

/**
 * Inline-editable plain text: shows the value with a pencil that appears on hover;
 * clicking the text or pencil enters edit mode. Enter and blur commit, Escape cancels.
 * Empty or unchanged values are discarded without calling onSave.
 */
export function EditableText({ value, onSave, isPending, className, inputClassName, ariaLabel }: EditableTextProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function startEditing() {
    setDraft(value);
    setIsEditing(true);
  }

  function commit() {
    const next = draft.trim();
    setIsEditing(false);
    if (next === "" || next === value) return;
    onSave(next);
  }

  if (isEditing) {
    return (
      <Input
        aria-label={ariaLabel}
        autoFocus
        disabled={isPending}
        value={draft}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setIsEditing(false);
          }
        }}
        className={cn("h-auto w-auto min-w-0 max-w-full py-0.5", inputClassName)}
      />
    );
  }

  return (
    <div className={cn("group inline-flex items-center gap-2", className)}>
      <button
        type="button"
        onClick={startEditing}
        className="cursor-text truncate bg-transparent text-left outline-none"
      >
        {value}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={ariaLabel != null ? `Edit ${ariaLabel}` : "Edit"}
        onClick={startEditing}
        className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <PencilSimpleIcon size={14} />
      </Button>
    </div>
  );
}
