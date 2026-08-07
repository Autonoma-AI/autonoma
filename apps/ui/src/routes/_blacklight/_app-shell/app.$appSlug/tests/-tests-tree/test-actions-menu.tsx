import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@autonoma/blacklight";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useAuth } from "lib/auth";

interface TestActionsMenuProps {
  onRename: () => void;
  onDelete: () => void;
}

export function TestActionsMenu({ onRename, onDelete }: TestActionsMenuProps) {
  const { isAdmin } = useAuth();

  if (!isAdmin) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-text-tertiary hover:bg-surface-base hover:text-text-secondary"
          aria-label="Test actions"
        >
          <DotsThreeIcon size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={onRename}>
          <PencilSimpleIcon size={14} className="mr-2" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDelete} className="text-status-critical">
          <TrashIcon size={14} className="mr-2" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
