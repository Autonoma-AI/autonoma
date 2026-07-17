import { cn } from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { FolderIcon } from "@phosphor-icons/react/Folder";
import { FolderOpenIcon } from "@phosphor-icons/react/FolderOpen";
import { useTestChanges } from "../-use-test-changes";
import { ChildRow } from "./child-row";
import { FolderActionsMenu } from "./folder-actions-menu";
import { useTestsTree } from "./tests-tree-context";
import type { FolderNode } from "./tree-types";
import { collectDescendantTests } from "./tree-utils";

function countTests(node: FolderNode): number {
  return node.children.filter((c) => !("children" in c)).length;
}

function countSubfolders(node: FolderNode): number {
  return node.children.filter((c) => "children" in c).length;
}

interface FolderRowProps {
  node: FolderNode;
  level: number;
  siblingFolderIds: string[];
}

export function FolderRow({ node, level, siblingFolderIds }: FolderRowProps) {
  const {
    expandedFolders,
    toggleFolder,
    toggleFolderGroup,
    openCreateFolder,
    openRename,
    openMoveFolder,
    openDeleteFolder,
  } = useTestsTree();

  const changes = useTestChanges();
  const isExpanded = expandedFolders.has(node.id);
  // A folder reads as "new" when it holds any test added on this branch (matches the test rows themselves).
  const hasNewTest = collectDescendantTests(node).some((t) => changes.byTestId.get(t.id) === "added");

  const childFolderIds = node.children.filter((c): c is FolderNode => "children" in c).map((c) => c.id);

  function handleChevronClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (e.altKey) {
      toggleFolderGroup(siblingFolderIds, !isExpanded);
    } else {
      toggleFolder(node.id);
    }
  }

  function handleNameClick() {
    toggleFolder(node.id);
  }

  return (
    <div>
      <div
        className="group flex w-full items-center gap-1.5 py-1.5 pr-2 text-left text-sm transition-colors hover:bg-surface-base"
        style={{ paddingLeft: `${level * 16 + 12}px` }}
      >
        <button
          type="button"
          onClick={handleChevronClick}
          className="w-4 shrink-0 text-text-tertiary hover:text-text-secondary"
        >
          {isExpanded ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
        </button>
        <button type="button" onClick={handleNameClick} className="flex min-w-0 flex-1 items-center gap-1.5">
          {isExpanded ? (
            <FolderOpenIcon
              size={14}
              className={cn("shrink-0", hasNewTest ? "text-primary-ink" : "text-text-secondary")}
            />
          ) : (
            <FolderIcon size={14} className={cn("shrink-0", hasNewTest ? "text-primary-ink" : "text-text-secondary")} />
          )}
          <span className={cn("truncate", hasNewTest ? "text-primary-ink" : "text-text-secondary")}>{node.name}</span>
        </button>
        <span className="ml-auto shrink-0 text-xs text-text-tertiary">{node.children.length}</span>
        <FolderActionsMenu
          onNewSubfolder={() => openCreateFolder(node.id)}
          onRename={() => openRename("folder", node.id, node.name)}
          onMove={() => openMoveFolder(node.id, node.name)}
          onDelete={() => openDeleteFolder(node.id, node.name, countTests(node), countSubfolders(node))}
        />
      </div>

      {isExpanded &&
        node.children.map((child) => (
          <ChildRow
            key={`${"children" in child ? "folder" : "test"}:${child.id}`}
            node={child}
            level={level + 1}
            siblingFolderIds={childFolderIds}
          />
        ))}
    </div>
  );
}
